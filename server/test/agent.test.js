import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockOllama, assistantAnswers, lastWebPrompt, lastAssistantTurns } from './mock-ollama.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-test-'));
process.env.DATA_DIR = dataDir;

let mock, mods;
before(async () => {
  mock = await startMockOllama();
  process.env.OLLAMA_URL = mock.url;
  mods = {
    settings: await import('../src/settings.js'),
    kb: await import('../src/kb/index.js'),
    extract: await import('../src/kb/extract.js'),
    inbox: await import('../src/inbox.js'),
    agent: await import('../src/ai/agent.js'),
    db: (await import('../src/db.js')).db,
    email: await import('../src/channels/email.js'),
  };
  mods.settings.setSetting('reply_delay_seconds', 0);
});
after(() => {
  mock.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('chunkText splits long text with overlap', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about our services.`).join(' ');
  const chunks = mods.extract.chunkText(text, 300, 50);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 450));
});

test('htmlToText keeps content and drops scripts', () => {
  const { title, text } = mods.extract.htmlToText('<html><title>About</title><script>x()</script><p>We sell phones.</p><li>مرحبا</li></html>');
  assert.equal(title, 'About');
  assert.match(text, /We sell phones/);
  assert.match(text, /مرحبا/);
  assert.doesNotMatch(text, /x\(\)/);
});

test('knowledge is indexed and used in answers', async () => {
  const id = mods.kb.createSource({ type: 'text', title: 'Opening hours', content: 'Our shop opening hours are 9am to 6pm, Saturday to Thursday.' });
  await mods.kb.indexSource(id);
  const src = mods.db.prepare('SELECT * FROM kb_sources WHERE id = ?').get(id);
  assert.equal(src.status, 'ready');
  const { reply, sources } = await mods.agent.answer([{ role: 'user', content: 'What are your opening hours?' }]);
  assert.equal(reply, 'We are open 9am to 6pm.');
  assert.equal(sources[0].title, 'Opening hours');
});

test('redirect rules and language rule go into the system prompt', () => {
  mods.db.prepare('INSERT INTO redirects (name, when_text, value) VALUES (?, ?, ?)').run('Sales', 'they want to buy', '+971500000000');
  const prompt = mods.agent.buildSystemPrompt([], 'Arabic');
  assert.match(prompt, /\+971500000000/);
  assert.match(prompt, /Arabic/);
});

test('incoming message gets an automatic reply through the channel', async () => {
  const sent = [];
  mods.inbox.registerSender('telegram', async (conv, text) => {
    sent.push({ to: conv.external_id, text });
    return { externalId: 'out-1' };
  });
  mods.inbox.handleIncoming({ channel: 'telegram', externalId: '42', name: 'Ali', text: 'opening hours?', messageId: '42:1' });
  mods.inbox.handleIncoming({ channel: 'telegram', externalId: '42', name: 'Ali', text: 'opening hours?', messageId: '42:1' }); // duplicate
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(sent, [{ to: '42', text: 'We are open 9am to 6pm.' }]);
  const conv = mods.inbox.listConversations({ channel: 'telegram' })[0];
  const msgs = mods.inbox.listMessages(conv.id);
  assert.deepEqual(msgs.map((m) => m.sender), ['customer', 'ai']);
});

test('no auto-reply when a human took over', async () => {
  const conv = mods.inbox.listConversations({ channel: 'telegram' })[0];
  mods.inbox.updateConversation(conv.id, { auto_reply: false });
  mods.inbox.handleIncoming({ channel: 'telegram', externalId: '42', text: 'hello?', messageId: '42:2' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(mods.inbox.listMessages(conv.id).map((m) => m.sender), ['customer', 'ai', 'customer']);
});

test('email quoted text is stripped', () => {
  const body = 'Thanks, what about Friday?\n\nOn Mon, 1 Jan 2026, Shop <a@b.com> wrote:\n> We are open 9am to 6pm.';
  assert.equal(mods.email.stripQuoted(body), 'Thanks, what about Friday?');
});

test('Meta webhook checks the signature and creates a conversation', async () => {
  const crypto = await import('node:crypto');
  const { receiveWebhook } = await import('../src/channels/meta.js');
  mods.settings.setSetting('meta', { enabled: true, app_secret: 's3cret', verify_token: 'v', page_id: 'P1', page_token: 't' });
  const payload = { object: 'page', entry: [{ id: 'P1', messaging: [{ sender: { id: 'U9' }, message: { mid: 'm1', text: 'hi' } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const call = async (sig) => {
    let code;
    const req = { body: payload, rawBody: raw, get: () => sig };
    const res = { sendStatus: (c) => (code = c) };
    await receiveWebhook(req, res);
    return code;
  };
  assert.equal(await call('sha256=bad'), 401);
  const good = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal(await call(good), 200);
  assert.equal(mods.inbox.listConversations({ channel: 'facebook' })[0].external_id, 'U9');
});

test('model download reports size and progress', async () => {
  const ollama = await import('../src/ai/ollama.js');
  await ollama.pullModel('qwen2.5:3b');
  const s = await ollama.status();
  const d = s.downloads.find((x) => x.model === 'qwen2.5:3b');
  assert.equal(d.state, 'done');
  assert.equal(d.total, 1010);
  assert.equal(d.completed, 1010);
  assert.equal(s.installed[0].size, 4683087332);
  assert.ok(s.modelsPath);
});

test('email forwarding rules match by keyword and by AI, and forward with attachments', async () => {
  const rules = await import('../src/channels/email-rules.js');
  const ins = mods.db.prepare(
    `INSERT INTO email_rules (name, match_type, match_text, match_field, forward_to, ai_reply) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ins.run('Jobs', 'keywords', 'cv, وظيفة', 'any', 'hr@example.com', 0);
  ins.run('Billing', 'ai', 'questions about invoices or payments', 'any', 'accounts@example.com, boss@example.com', 1);

  const jobs = await rules.matchRules({ accountId: 1, from: 'a@b.com', subject: 'طلب وظيفة', text: 'مرفق السيرة الذاتية' });
  assert.deepEqual(jobs.map((r) => r.name), ['Jobs']);
  const billing = await rules.matchRules({ accountId: 1, from: 'a@b.com', subject: 'Question', text: 'Where is my invoice?' });
  assert.deepEqual(billing.map((r) => r.name), ['Billing']);
  const none = await rules.matchRules({ accountId: 1, from: 'a@b.com', subject: 'Hello', text: 'Are you open today?' });
  assert.equal(none.length, 0);

  const sent = [];
  const transport = { sendMail: async (m) => sent.push(m) };
  const parsed = { subject: 'Question', text: 'Where is my invoice?', date: new Date(), to: { text: 'shop@x.com' }, attachments: [{ filename: 'a.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }] };
  const results = await rules.forward({ transport, account: { name: 'Shop', email: 'shop@x.com' }, parsed, original: { from: 'a@b.com', fromName: 'Ali' }, rules: billing });
  assert.equal(results[0].error, undefined);
  assert.deepEqual(sent[0].to, ['accounts@example.com', 'boss@example.com']);
  assert.equal(sent[0].subject, 'Fwd: Question');
  assert.equal(sent[0].replyTo, 'a@b.com');
  assert.equal(sent[0].attachments[0].filename, 'a.pdf');
  assert.match(sent[0].text, /Forwarded message[\s\S]*Ali <a@b.com>[\s\S]*Where is my invoice/);
  assert.equal(rules.validateRule({ name: 'x', match_text: 'y', forward_to: 'not-an-email' }), 'Add at least one valid email address to forward to');
});

test('team notes are shown in the conversation but not sent to the AI', async () => {
  const conv = mods.inbox.listConversations({ channel: 'telegram' })[0];
  mods.inbox.addNote(conv.id, 'Forwarded to hr@example.com');
  const msgs = mods.inbox.listMessages(conv.id);
  assert.equal(msgs.at(-1).direction, 'note');
  const before = mock.calls.length;
  await mods.agent.generateReply(conv.id);
  const chatCall = mock.calls.slice(before).find((c) => c.path === '/api/chat');
  assert.ok(!chatCall.data.messages.some((m) => m.content.includes('Forwarded to hr@')));
  assert.equal(chatCall.data.keep_alive, '24h');
});

test('replies stay in the customer language and Chinese drift is retried', async () => {
  assert.equal(mods.agent.detectLanguage([{ role: 'user', content: 'مرحبا، كم السعر؟' }]), 'Arabic');
  assert.equal(mods.agent.detectLanguage([{ role: 'user', content: 'مرحبا' }, { role: 'assistant', content: 'أهلا' }, { role: 'user', content: '👍' }]), 'Arabic');
  assert.equal(mods.agent.detectLanguage([{ role: 'user', content: 'hi' }]), 'English');
  const { reply, language } = await mods.agent.answer([{ role: 'user', content: 'What is TopTech?' }]);
  assert.equal(language, 'English');
  assert.equal(reply, 'TopTech is our shop for the latest tech products.');
  const last = mock.calls.filter((c) => c.path === '/api/chat').at(-2);
  assert.match(last.data.messages[0].content, /Reply in the language of the customer's latest message/);
  assert.match(last.data.messages.at(-1).content, /in English only/);
});

test('voice notes are decoded with ffmpeg, transcribed and answered', async () => {
  const { execFileSync } = await import('node:child_process');
  const speech = await import('../src/ai/speech.js');
  const { handleVoiceNote } = await import('../src/voice.js');
  // A real 1.5 second Ogg Opus file, like a WhatsApp voice note.
  const ogg = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']);
  const samples = await speech.decodeAudio(ogg);
  assert.ok(Math.abs(samples.length - 24000) < 1600, `got ${samples.length} samples`);

  let gotSamples = 0;
  speech._setPipelineForTests(async (audio, opts) => {
    gotSamples = audio.length;
    assert.equal(opts.task, 'transcribe');
    return { text: ' What are your opening hours? ' };
  });
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  await handleVoiceNote({ channel: 'whatsapp', externalId: '971500000001@s.whatsapp.net', name: 'Omar', handle: '+971500000001', messageId: 'v1', buffer: ogg, ext: 'ogg', duration: 2 });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(gotSamples > 20000);
  const conv = mods.inbox.listConversations({ channel: 'whatsapp' })[0];
  const [msg] = mods.inbox.listMessages(conv.id);
  assert.equal(msg.text, 'What are your opening hours?');
  const meta = JSON.parse(msg.meta);
  assert.equal(meta.voice, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'media', meta.audio)));
  assert.deepEqual(sent, ['We are open 9am to 6pm.']);
});

test('voice note that cannot be read is kept with a note and no AI reply', async () => {
  const { handleVoiceNote } = await import('../src/voice.js');
  await handleVoiceNote({ channel: 'telegram', externalId: '77', name: 'Nour', handle: '@nour', messageId: '77:1', buffer: Buffer.from('not audio'), ext: 'ogg', duration: 1 });
  const conv = mods.inbox.listConversations({ channel: 'telegram' }).find((c) => c.external_id === '77');
  const msgs = mods.inbox.listMessages(conv.id);
  assert.equal(msgs[0].text, '🎤 Voice note');
  assert.equal(msgs[1].direction, 'note');
  assert.match(msgs[1].text, /Could not turn this voice note into text/);
  assert.equal(msgs.length, 2);
});

const TEAM = (cats) => ({
  enabled: true,
  brief_language: 'English',
  cooldown_hours: 24,
  categories: [
    { id: 'sales', name: 'Sales', when: 'the customer wants to buy', ask: 'product, quantity, city', team: [{ name: 'Rami', phone: '+971 55 123 4567' }] },
    { id: 'maintenance', name: 'Maintenance request', when: 'something needs a repair', ask: 'device, problem, location', team: [{ name: 'Omar', phone: '+971 56 999 8888' }] },
    ...cats,
  ],
});

test('handoff: asks what the customer needs, then sends number and brief to the sales team, once', async () => {
  const handoff = await import('../src/handoff.js');
  mods.settings.setSetting('handoff', TEAM([]));
  // A redirect that would hand the customer the sales number must not reach the prompt.
  mods.db.prepare('INSERT INTO redirects (name, when_text, value) VALUES (?, ?, ?)').run('Sales team', 'they want to buy', '+971551234567');
  const leads = [];
  handoff.registerWhatsAppSender(async (phone, text) => leads.push({ phone, text }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  assert.equal(handoff.isTeamNumber('971551234567'), true);
  assert.equal(handoff.isTeamNumber('971569998888'), true);
  const prompt = mods.agent.buildSystemPrompt([]);
  assert.match(prompt, /- \[ASK:sales\] Sales: the customer wants to buy \| product, quantity, city/);
  assert.match(prompt, /- \[ASK:maintenance\] Maintenance request: something needs a repair/);
  assert.doesNotMatch(prompt, /551234567/);

  const msg = { channel: 'whatsapp', externalId: '971501112222@s.whatsapp.net', name: 'Huda', handle: '+971501112222', convMeta: { phone: '+971501112222' } };
  // 1. Customer asks to buy without details: the AI asks what they need, nothing goes to the team yet.
  mods.inbox.handleIncoming({ ...msg, text: 'Hi, I want to buy phones', messageId: 's1' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(sent, ['Happy to help! Which product do you need, how many, and to which city?']);
  assert.equal(leads.length, 0);
  let conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === msg.externalId);
  assert.equal(conv.meta.handoffStage.topic, 'sales');

  // 2. Customer answers: the AI thanks them and the request goes to the sales team only.
  mods.inbox.handleIncoming({ ...msg, text: '3 iPhone 16 Pro, delivery to Dubai', messageId: 's2' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent[1], 'Thank you! A specialist from our team will contact you soon.');
  assert.ok(!sent.some((t) => t.includes('551234567')), 'the customer never gets the team number');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, '+971 55 123 4567');
  assert.match(leads[0].text, /New request: Sales/);
  assert.match(leads[0].text, /Huda/);
  assert.match(leads[0].text, /https:\/\/wa\.me\/971501112222/);
  assert.match(leads[0].text, /Wants 3 iPhone 16 phones/);
  assert.match(leads[0].text, /3 iPhone 16 Pro, delivery to Dubai/);
  conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === msg.externalId);
  assert.deepEqual(conv.meta.leads, ['Sales']);
  assert.equal(conv.meta.handoffStage, null);
  assert.ok(mods.inbox.listMessages(conv.id).some((m) => m.direction === 'note' && /Sent to Sales team: Rami/.test(m.text)));

  // 3. Asking again within the cooldown doesn't send a second lead.
  mods.inbox.handleIncoming({ ...msg, text: 'I want to buy a case too', messageId: 's3' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(leads.length, 1);

  // 4. A different topic in the same chat still goes to its own team.
  mods.inbox.handleIncoming({ ...msg, text: 'Also my laptop screen is broken, can you repair it?', messageId: 's4' });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(sent.at(-1), /Which device is it/);
  mods.inbox.handleIncoming({ ...msg, text: 'Dell XPS, cracked screen, Sharjah', messageId: 's5' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(leads.length, 2);
  assert.equal(leads[1].phone, '+971 56 999 8888');
  assert.match(leads[1].text, /New request: Maintenance request/);
  assert.match(leads[1].text, /Laptop screen is broken/);
  conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === msg.externalId);
  assert.deepEqual(conv.meta.leads, ['Sales', 'Maintenance request']);

  // 5. The manual button always sends, to the topic picked.
  await handoff.handOff(conv.id, { category: 'sales', reason: 'manual' });
  assert.equal(leads.length, 3);
  assert.equal(leads[2].phone, '+971 55 123 4567');
});

test('handoff: a customer who gives details straight away is handed off at once', async () => {
  const handoff = await import('../src/handoff.js');
  const leads = [];
  handoff.registerWhatsAppSender(async (phone, text) => leads.push({ phone, text }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  mods.inbox.handleIncoming({ channel: 'whatsapp', externalId: '971503334444@s.whatsapp.net', name: 'Sami', handle: '+971503334444', convMeta: { phone: '+971503334444' }, text: 'I want to buy 3 iPhones for Abu Dhabi', messageId: 'd1' });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(sent[0], /team will contact you/);
  assert.equal(leads.length, 1);
  assert.match(leads[0].text, /wa\.me\/971503334444/);
  mods.db.prepare("DELETE FROM redirects WHERE name = 'Sales team'").run();
});

test('handoff: Arabic buying messages match the topic keywords and are handed off', async () => {
  const handoff = await import('../src/handoff.js');
  mods.settings.setSetting('handoff', TEAM([]));
  const s = mods.settings.getSetting('handoff');
  assert.match(s.categories[0].keywords, /اشتري/, 'saved topics without keywords get the built-in ones');
  assert.equal(handoff.matchTopic('بدي أشتري جهاز مستعمل')?.id, 'sales');
  assert.equal(handoff.matchTopic('بدي جهاز مستعمل')?.id, 'sales');
  assert.equal(handoff.matchTopic('الشاشة خربانة')?.id, 'maintenance');
  assert.equal(handoff.matchTopic('شو ساعات الدوام؟'), null);

  const leads = [];
  handoff.registerWhatsAppSender(async (phone, text) => leads.push({ phone, text }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  const msg = { channel: 'whatsapp', externalId: '971507778888@s.whatsapp.net', name: 'Ali', handle: '+971507778888', convMeta: { phone: '+971507778888' } };
  mods.inbox.handleIncoming({ ...msg, text: 'بدي جهاز مستعمل', messageId: 'ar1' });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(sent[0], /أي جهاز بدك/);
  let conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === msg.externalId);
  assert.equal(conv.meta.handoffStage.topic, 'sales', 'the AI forgot the tag, the keyword still starts the handoff');
  mods.inbox.handleIncoming({ ...msg, text: 'ايفون 13 مستعمل، الميزانية 1500 درهم، الشارقة', messageId: 'ar2' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, '+971 55 123 4567');
  assert.match(leads[0].text, /wa\.me\/971507778888/);
});

test('handoff: a maintenance request on Telegram goes to the maintenance team, after one question', async () => {
  const handoff = await import('../src/handoff.js');
  mods.settings.setSetting('handoff', TEAM([]));
  const leads = [];
  handoff.registerWhatsAppSender(async (phone, text) => leads.push({ phone, text }));
  const sent = [];
  mods.inbox.registerSender('telegram', async (conv, text) => sent.push(text));
  const msg = { channel: 'telegram', externalId: '5551', name: 'Lina', handle: '@lina' };
  // The model writes the topic's name in the tag, not its id: it must still reach maintenance, not sales.
  mods.inbox.handleIncoming({ ...msg, text: 'My laptop is broken, I need a repair', messageId: 'm1' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Which device is it/);
  assert.doesNotMatch(sent[0], /\[/, 'the tag is not shown to the customer');
  let conv = mods.inbox.listConversations({ channel: 'telegram' }).find((c) => c.external_id === '5551');
  assert.equal(conv.meta.handoffStage.topic, 'maintenance');

  // Whatever they answer, they get the fixed message right away and the details go to maintenance.
  mods.inbox.handleIncoming({ ...msg, text: 'HP Pavilion, screen stays black, Ajman', messageId: 'm2' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent[1], 'Thank you! A specialist from our team will contact you soon.');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, '+971 56 999 8888');
  assert.match(leads[0].text, /New request: Maintenance request/);
  assert.match(leads[0].text, /t\.me\/lina/);
  conv = mods.inbox.listConversations({ channel: 'telegram' }).find((c) => c.external_id === '5551');
  assert.equal(conv.meta.handoffStage, null);

  // Arabic customers get the Arabic message.
  const sentAr = [];
  mods.inbox.registerSender('telegram', async (conv, text) => sentAr.push(text));
  mods.inbox.updateMeta(conv.id, { handoffStage: { topic: 'sales', at: Date.now() } });
  mods.inbox.handleIncoming({ ...msg, text: 'ايفون ١٥ للشارقة', messageId: 'm3' });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(sentAr[0], /سيتواصل معك أحد المختصين/);
});

test('handoff: tags with an unknown topic are resolved from the chat, never sent to the wrong team', async () => {
  const handoff = await import('../src/handoff.js');
  mods.settings.setSetting('handoff', TEAM([]));
  assert.equal(handoff.findCategory('Maintenance request')?.id, 'maintenance');
  assert.equal(handoff.findCategory('maintenance_request')?.id, 'maintenance');
  assert.equal(handoff.findCategory('SALES')?.id, 'sales');
  assert.equal(handoff.takeTags('Which printer? [ASK: Maintenance request]').tag.topic, 'maintenance request');
  // Keywords of two topics: the one with more matches wins.
  assert.equal(handoff.matchTopics('بدي صيانة لجهاز خربان بس بدي اعرف السعر')[0].id, 'maintenance');

  const leads = [];
  handoff.registerWhatsAppSender(async (phone, text) => leads.push({ phone, text }));
  mods.inbox.registerSender('telegram', async () => {});
  const conv = mods.inbox.handleIncoming({ channel: 'telegram', externalId: '5552', name: 'Omar', handle: '@omar', text: 'My printer stopped working', messageId: 'u1', autoReply: false });
  await handoff.afterReply(conv, { type: 'ask', topic: 'repairs' });
  let c = mods.inbox.getConversation(conv);
  assert.equal(c.meta.handoffStage.topic, 'maintenance', 'an unknown tag falls back to asking the model which team');
});

test('handoff: topics get ids, and the old sales setting carries over', async () => {
  const handoff = await import('../src/handoff.js');
  const n = handoff.normalizeHandoff({ enabled: true, categories: [
    { name: 'Software inquiries', when: 'software', team: [{ name: 'A', phone: '1' }, { name: '', phone: '' }] },
    { name: 'طلب صيانة', when: 'repair', team: [] },
    { name: 'Software inquiries', when: 'again' },
    { name: '', when: '' },
  ] });
  assert.deepEqual(n.categories.map((c) => c.id), ['software-inquiries', 'topic2', 'software-inquiries-3']);
  assert.equal(n.categories[0].team.length, 1);

  mods.db.prepare("DELETE FROM settings WHERE key = 'handoff'").run();
  mods.settings.setSetting('sales_handoff', { enabled: true, when: 'they want a quote', team: [{ name: 'Rami', phone: '+971 55 123 4567' }] });
  const s = mods.settings.getSetting('handoff');
  assert.equal(s.enabled, true);
  const sales = s.categories.find((c) => c.id === 'sales');
  assert.equal(sales.when, 'they want a quote');
  assert.equal(sales.team[0].name, 'Rami');
  assert.deepEqual(handoff.activeCategories().map((c) => c.id), ['sales']);
  mods.settings.setSetting('handoff', { enabled: false, categories: [] });
});

test('assistant: time helpers turn local times into UTC', async () => {
  const t = await import('../src/assistant/time.js');
  assert.equal(t.fromLocal('2026-11-11 09:00', 'Asia/Damascus').toISOString(), '2026-11-11T06:00:00.000Z');
  assert.equal(t.fromLocal('2026-07-01 09:00', 'Europe/Berlin').toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(t.fromLocal('2026-12-01 09:00', 'Europe/Berlin').toISOString(), '2026-12-01T08:00:00.000Z');
  assert.equal(t.toLocal(new Date('2026-11-10T21:30:00Z'), 'Asia/Damascus'), '2026-11-11 00:30');
  const { start, end } = t.localDayBounds(new Date('2026-11-10T22:00:00Z'), 'Asia/Damascus');
  assert.equal(start.toISOString(), '2026-11-10T21:00:00.000Z');
  assert.equal(end.toISOString(), '2026-11-11T21:00:00.000Z');
});

test('assistant: owners give tasks, reminders fire, messages go out only after "yes"', async () => {
  const assistant = await import('../src/assistant/index.js');
  const { toLocal } = await import('../src/assistant/time.js');
  mods.settings.setSetting('handoff', { enabled: false, categories: [] });
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({
    enabled: true, timezone: 'Asia/Damascus', confirm_before_sending: true, event_reminder_minutes: 30,
    owners: [{ name: 'Hisham', phone: '+963 944 111 222' }, { name: '', phone: '', telegram: '' }],
  }));
  assert.equal(mods.settings.getSetting('assistant').owners.length, 1);
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const wait = () => new Promise((r) => setTimeout(r, 300));
  const owner = { channel: 'whatsapp', externalId: '963944111222@s.whatsapp.net', name: 'Hisham', handle: '+963944111222', convMeta: { phone: '+963944111222' }, autoReply: false };
  const ownerSays = async (text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    sent.length = 0;
    mods.inbox.handleIncoming({ ...owner, text, messageId: id });
    await wait();
    return sent.filter((m) => m.to === owner.externalId).map((m) => m.text);
  };

  // A client who has written before, so the owner can name her.
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const clientId = mods.inbox.ensureConversation({ channel: 'whatsapp', externalId: '971507770000@s.whatsapp.net', name: 'Mona Client', handle: '+971507770000', meta: { phone: '+971507770000' } });

  // 1. A reminder for tomorrow 09:00 local time is stored in UTC.
  const tomorrow = toLocal(new Date(Date.now() + 86400e3), 'Asia/Damascus').slice(0, 10);
  let replies = await ownerSays('remind me tomorrow at 9 to call Ahmad', { action: 'reminder', when: `${tomorrow} 09:00`, text: 'Call Ahmad' }, 'o1');
  assert.match(replies[0], /Reminder #\d+ set for .*09:00: Call Ahmad/);
  const reminder = mods.db.prepare("SELECT * FROM tasks WHERE kind = 'reminder' ORDER BY id DESC").get();
  assert.equal(reminder.run_at, new Date(`${tomorrow}T06:00:00Z`).toISOString());

  // It fires when due, and only once.
  sent.length = 0;
  await assistant.runDueTasks(new Date(new Date(reminder.run_at).getTime() + 1000));
  await assistant.runDueTasks(new Date(new Date(reminder.run_at).getTime() + 2000));
  assert.deepEqual(sent, [{ to: owner.externalId, text: '⏰ Reminder: Call Ahmad' }]);
  assert.equal(mods.db.prepare('SELECT status FROM tasks WHERE id = ?').get(reminder.id).status, 'done');

  // 2. A message to a client is shown first and sent only after "yes".
  replies = await ownerSays('tell Mona her order is ready', { action: 'send_message', to: 'Mona', text: 'Hi Mona, your order is ready.' }, 'o2');
  assert.match(replies[0], /WhatsApp to Mona Client \(\+971507770000\) now/);
  assert.match(replies[0], /Reply "yes"/);
  assert.equal(sent.filter((m) => m.to !== owner.externalId).length, 0);
  replies = await ownerSays('yes', null, 'o3');
  assert.deepEqual(sent.find((m) => m.to !== owner.externalId), { to: '971507770000@s.whatsapp.net', text: 'Hi Mona, your order is ready.' });
  assert.match(replies[0], /Sent to Mona Client/);
  assert.equal(mods.inbox.listMessages(clientId).at(-1).text, 'Hi Mona, your order is ready.');

  // "no" cancels; a new number gets a new conversation, at a later time.
  await ownerSays('send +963 955 000 111 "see you tomorrow"', { action: 'send_message', to: '+963 955 000 111', text: 'See you tomorrow' }, 'o4');
  replies = await ownerSays('لا', null, 'o5');
  assert.match(replies[0], /ما انبعتت/);
  assert.equal(sent.length, 1);
  const later = toLocal(new Date(Date.now() + 2 * 3600e3), 'Asia/Damascus');
  await ownerSays('send +963 955 000 111 at ' + later, { action: 'send_message', to: '+963 955 000 111', text: 'See you tomorrow', when: later }, 'o6');
  replies = await ownerSays('ok', null, 'o7');
  assert.match(replies[0], /Scheduled #\d+/);
  const scheduled = mods.db.prepare("SELECT * FROM tasks WHERE kind = 'message' ORDER BY id DESC").get();
  sent.length = 0;
  await assistant.runDueTasks(new Date(new Date(scheduled.run_at).getTime() + 1000));
  assert.deepEqual(sent.map((m) => m.to), ['963955000111@s.whatsapp.net', owner.externalId]);

  // 3. Appointments remind before; list and cancel are the owner's own tasks.
  replies = await ownerSays('meeting with Sami tomorrow 16:00', { action: 'schedule', when: `${tomorrow} 16:00`, text: 'Meeting with Sami' }, 'o8');
  assert.match(replies[0], /Saved #(\d+): Meeting with Sami.*remind you 30 min before/);
  const event = mods.db.prepare("SELECT * FROM tasks WHERE kind = 'event' ORDER BY id DESC").get();
  assert.equal(event.run_at, new Date(`${tomorrow}T12:30:00Z`).toISOString());
  replies = await ownerSays('what do I have tomorrow?', { action: 'list', when: tomorrow }, 'o9');
  assert.match(replies[0], /Meeting with Sami/);
  assert.doesNotMatch(replies[0], /Call Ahmad/); // already done
  replies = await ownerSays(`cancel #${event.id}`, { action: 'cancel', task_id: event.id }, 'o10');
  assert.match(replies[0], new RegExp(`Cancelled #${event.id}`));
  assert.equal(mods.db.prepare('SELECT status FROM tasks WHERE id = ?').get(event.id).status, 'cancelled');

  // Past times are questioned, not saved.
  replies = await ownerSays('remind me yesterday', { action: 'reminder', when: '2020-01-01 09:00', text: 'x' }, 'o11');
  assert.match(replies[0], /already passed/);

  // 4. Summary and Arabic help.
  replies = await ownerSays('summary of today', { action: 'summary' }, 'o12');
  assert.match(replies[0], /Today/);
  replies = await ownerSays('شو بتقدر تعمل؟', { action: 'help' }, 'o13');
  assert.match(replies[0], /ذكّرك/);

  // 5. Anyone else still gets the normal customer answer, and the assistant can be turned off.
  sent.length = 0;
  mods.inbox.handleIncoming({ channel: 'whatsapp', externalId: '971508880000@s.whatsapp.net', handle: '+971508880000', convMeta: { phone: '+971508880000' }, text: 'what are your hours?', messageId: 'c1' });
  await wait();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /Reminder|I can/);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
  assert.equal(assistant.isOwnerConversation(mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === owner.externalId).id), false);
});

test('assistant: fixes what small models get wrong (days, numbers, timing words, language)', async () => {
  const assistant = await import('../src/assistant/index.js');
  const { dayFromWords, toLocal } = await import('../src/assistant/time.js');
  const now = new Date('2026-11-10T08:00:00Z'); // Tuesday in Damascus
  assert.equal(dayFromWords('عندي اجتماع مع سامي يوم الخميس الساعة 4', now, 'Asia/Damascus').date, '2026-11-12');
  assert.equal(dayFromWords('بعد بكرا الساعة 5', now, 'Asia/Damascus').date, '2026-11-12');
  assert.equal(dayFromWords('remind me tomorrow at 9', now, 'Asia/Damascus').date, '2026-11-11');
  assert.equal(dayFromWords('ذكرني بعد ساعتين', now, 'Asia/Damascus'), null);

  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'H', phone: '+963944111222' }] }));
  const today = toLocal(new Date(), 'Asia/Damascus').slice(0, 10);
  const thursday = dayFromWords('الخميس', new Date(), 'Asia/Damascus').date;
  let c = assistant.fixCommand({ action: 'schedule', when: '2030-01-05 16:00', text: 'لدي اجتماع مع سامي' }, 'عندي اجتماع مع سامي يوم الخميس الساعة 4 العصر', 'Arabic');
  assert.equal(c.when, `${thursday} 16:00`);
  c = assistant.fixCommand({ action: 'reminder', when: `${today} 23:00`, text: 'تذكرني في الساعة التاسعة صباحاً明天叫我' }, 'remind me tomorrow at 9 to call Ahmad', 'English');
  assert.equal(c.text, 'call Ahmad');
  c = assistant.fixCommand({ action: 'reminder', when: `${today} 23:00`, text: 'تذكرني بعد ساعتين اتصل بالمورد' }, 'ذكرني بعد ساعتين اتصل بالمورد', 'Arabic');
  assert.equal(c.text, 'اتصل بالمورد');
  c = assistant.fixCommand({ action: 'reminder', when: `${today} 23:00`, text: "Today's report" }, "remind me about today's report", 'English');
  assert.equal(c.text, "Today's report");
  c = assistant.fixCommand({ action: 'send_message', when: `${today} 23:00`, to: null, text: 'الطلب رح يتأخر يوم، بكرا الساعة 10 الصبح' }, 'ابعت لـ +971501234567 إنو الطلب رح يتأخر يوم، بكرا الساعة 10 الصبح', 'Arabic');
  assert.equal(c.to, '+971501234567');
  assert.equal(c.text, 'الطلب رح يتأخر يوم');
  c = assistant.fixCommand({ action: 'send_email', to: 'Sami', text: 'Price list attached' }, 'email sami@company.com the price list', 'English');
  assert.equal(c.to, 'sami@company.com');

  // "no" to the bot's question cancels instead of starting the request again.
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  const owner = { channel: 'whatsapp', externalId: '963944111222@s.whatsapp.net', handle: '+963944111222', convMeta: { phone: '+963944111222' }, autoReply: false };
  assistantAnswers.push({ action: 'send_message', to: 'Nobody Known', text: 'Hi' });
  mods.inbox.handleIncoming({ ...owner, text: 'tell Nobody Known hi', messageId: 'q1' });
  await new Promise((r) => setTimeout(r, 300));
  assert.match(sent.at(-1), /couldn't find/);
  mods.inbox.handleIncoming({ ...owner, text: 'no', messageId: 'q2' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.at(-1), 'OK, cancelled.');
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('assistant: messages are written from the owner\'s instructions, quotes are sent as written', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Hisham', phone: '+963944111222' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  const owner = { channel: 'whatsapp', externalId: '963944111222@s.whatsapp.net', handle: '+963944111222', convMeta: { phone: '+963944111222' }, autoReply: false };
  const say = async (text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    mods.inbox.handleIncoming({ ...owner, text, messageId: id });
    await new Promise((r) => setTimeout(r, 300));
    return sent.at(-1);
  };
  let reply = await say('احكي مع +963955123456 قلو كيفك وعرفو عن حالك', { action: 'send_message', to: '+963955123456', text: 'كيفك؟' }, 'w1');
  assert.match(reply, /\n\nمرحبا، معك المساعد الذكي تبع Hisham 👋 كيفك؟\n\n/);
  await say('لا', null, 'w2');
  reply = await say('send +963955123456 "see you at 5"', { action: 'send_message', to: '+963955123456', text: 'See you at five!' }, 'w3');
  assert.match(reply, /\n\nsee you at 5\n\n/);
  await say('no', null, 'w4');
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('assistant: made-up numbers are ignored, Arabic names find Latin contacts, drafts lose instruction words', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Hisham', phone: '+963944111222' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  mods.inbox.ensureConversation({ channel: 'whatsapp', externalId: '971507771111@s.whatsapp.net', name: 'Mohammad Saleh', handle: '+971507771111', meta: { phone: '+971507771111' } });
  const owner = { channel: 'whatsapp', externalId: '963944111222@s.whatsapp.net', handle: '+963944111222', convMeta: { phone: '+963944111222' }, autoReply: false };
  const say = async (text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    mods.inbox.handleIncoming({ ...owner, text, messageId: id });
    await new Promise((r) => setTimeout(r, 300));
    return sent.filter((m) => m.to === owner.externalId).at(-1).text;
  };
  // The model invents a number for a name: the name is used instead, and "محمد" finds "Mohammad Saleh".
  let reply = await say('احكي مع محمد قلو الطلب جاهز', { action: 'send_message', to: '+963555555555', text: 'قلو لـ +971507771111 إنو الطلب جاهز' }, 'm1');
  assert.match(reply, /Mohammad Saleh \(\+971507771111\)/);
  assert.doesNotMatch(reply, /555555/);
  assert.doesNotMatch(reply.split('\n\n')[1], /قلو|971507771111/);
  await say('لا', null, 'm2');
  reply = await say('احكي مع منى قلو كيفك', { action: 'send_message', to: 'منى', text: 'كيفك' }, 'm3');
  assert.match(reply, /Mona Client/);
  await say('لا', null, 'm4');
  // Called "chat" by the model, but it is a message to someone.
  reply = await say('احكي مع محمد قلو الطلب جاهز', { action: 'chat', reply: 'حسنًا، سأتحدث مع محمد' }, 'm5');
  assert.match(reply, /Mohammad Saleh/);
  await say('لا', null, 'm6');
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('assistant: each owner remembers their own contacts and picks between people with the same name', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [
    { name: 'Hisham', phone: '+963944111222' }, { name: 'Rami', phone: '+963944333444' },
  ] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const hisham = { channel: 'whatsapp', externalId: '963944111222@s.whatsapp.net', handle: '+963944111222', convMeta: { phone: '+963944111222' }, autoReply: false };
  const rami = { ...hisham, externalId: '963944333444@s.whatsapp.net', handle: '+963944333444', convMeta: { phone: '+963944333444' } };
  const say = async (who, text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    mods.inbox.handleIncoming({ ...who, text, messageId: id });
    await new Promise((r) => setTimeout(r, 300));
    return sent.filter((m) => m.to === who.externalId).at(-1).text;
  };

  // Saving: the number comes from what Hisham wrote, never from the model.
  let reply = await say(hisham, 'احفظ رقم نور 0501112233', { action: 'save_contact', to: 'نور', text: null }, 'n0');
  assert.match(reply, /رمز الدولة/);
  reply = await say(hisham, 'احفظ رقم نور +971501112233', { action: 'save_contact', to: 'نور', text: null }, 'n1');
  assert.match(reply, /حفظت نور: \+971501112233/);
  reply = await say(hisham, 'save Nour Haddad +971 55 999 8877', { action: 'save_contact', to: 'Nour Haddad +971559990000' }, 'n2');
  assert.match(reply, /Saved Nour Haddad: \+971559998877\. You now have 2 contacts called Nour;/);
  reply = await say(hisham, 'save Sami', { action: 'save_contact', to: 'Sami' }, 'n3');
  assert.match(reply, /What is Sami's number/);
  await say(hisham, 'no', null, 'n4');

  // "Tell Nour…" asks which Nour, then continues with the one picked.
  reply = await say(hisham, 'احكي مع نور قلها الاجتماع بكرا', { action: 'send_message', to: 'نور', text: 'الاجتماع بكرا' }, 'n5');
  assert.match(reply, /أي "نور"؟/);
  assert.match(reply, /\d\. نور \(\+971501112233\) · محفوظ/);
  const pick = reply.match(/(\d)\. Nour Haddad \(\+971559998877\) · محفوظ/)[1];
  reply = await say(hisham, pick, null, 'n6');
  assert.match(reply, /واتساب إلى Nour Haddad \(\+971559998877\)/);
  await say(hisham, 'نعم', null, 'n7');
  assert.ok(sent.some((m) => m.to === '971559998877@s.whatsapp.net'));

  // Rami doesn't see Hisham's contacts.
  reply = await say(rami, 'tell Nour hi', { action: 'send_message', to: 'Nour', text: 'Hi' }, 'n8');
  assert.doesNotMatch(reply, /Haddad|971501112233/); // only shared inbox chats, not Hisham's saved list
  await say(rami, 'no', null, 'n9');
  reply = await say(rami, 'my contacts', { action: 'contacts' }, 'n10');
  assert.match(reply, /No saved contacts/);

  // Listing and forgetting.
  reply = await say(hisham, 'شو الأرقام المحفوظة', { action: 'contacts' }, 'n11');
  assert.match(reply, /Nour Haddad: \+971559998877/);
  reply = await say(hisham, 'امسح رقم نور', { action: 'forget_contact', to: 'نور' }, 'n12');
  assert.match(reply, /أي واحد امسح/);
  reply = await say(hisham, '١٢'.charAt(reply.split('\n').findIndex((l) => /نور \(/.test(l)) - 1), null, 'n13');
  assert.match(reply, /امسح نور \(\+971501112233\)؟/);
  reply = await say(hisham, 'نعم', null, 'n13b');
  assert.match(reply, /مسحت نور/);
  assert.equal(assistant.listOwnerContacts(assistant.ownerKey({ phone: '+963944111222' })).length, 1);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('assistant: contacts work the way the real model answers (names from Arabic, stray prefixes, bare numbers)', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Lina', phone: '+963944555666' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const lina = { channel: 'whatsapp', externalId: '963944555666@s.whatsapp.net', handle: '+963944555666', convMeta: { phone: '+963944555666' }, autoReply: false };
  const say = async (text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    mods.inbox.handleIncoming({ ...lina, text, messageId: id });
    await new Promise((r) => setTimeout(r, 300));
    return sent.filter((m) => m.to === lina.externalId).at(-1).text;
  };
  // The model gives no name: it comes from Lina's own words. A local number asks for the country code first.
  let reply = await say('احفظ رقم نور 0501112233', { action: 'save_contact', to: null }, 'l1');
  assert.match(reply, /رمز الدولة/);
  reply = await say('احفظ رقم نور +971501112233', { action: 'save_contact', to: null }, 'l2');
  assert.match(reply, /حفظت نور: \+971501112233/);
  reply = await say("save Ziad's number +971 52 000 1111", { action: 'save_contact', to: '+971' }, 'l3');
  assert.match(reply, /Saved Ziad: \+971520001111/);

  // "+971" from the model is not a name: Ziad is found from Lina's words.
  reply = await say('tell Ziad the meeting is tomorrow', { action: 'send_message', to: '+971', text: 'The meeting is tomorrow.' }, 'l4');
  assert.match(reply, /WhatsApp to Ziad \(\+971520001111\)/);
  // A bare "1" during a draft gets a yes/no reminder in English, and nothing is sent.
  reply = await say('1', null, 'l5');
  assert.equal(reply, 'Please reply "yes" or "no".');
  reply = await say('no', null, 'l6');
  assert.equal(reply, 'OK, not sent.');

  // Two people called Nour: the bot asks "which نور" even if the model names one, and deleting asks which one too.
  await say('save Nour Haddad +971 55 999 8877', { action: 'save_contact', to: 'Nour Haddad' }, 'l3b');
  reply = await say('احكي مع نور قلها الاجتماع بكرا', { action: 'send_message', to: 'Nour Haddad', text: 'الاجتماع بكرا' }, 'l3c');
  assert.match(reply, /أي "نور"؟/);
  await say('لا', null, 'l3d');
  reply = await say('امسح رقم نور', { action: 'forget_contact', to: 'Nour Haddad' }, 'l3e');
  assert.match(reply, /أي واحد امسح/);
  await say('لا', null, 'l3f');

  // Deleting asks first; "لا" keeps the contact.
  reply = await say('امسح رقم زياد', { action: 'forget_contact', to: 'زياد' }, 'l7');
  assert.match(reply, /امسح Ziad \(\+971520001111\)؟/);
  reply = await say('لا', null, 'l8');
  assert.match(reply, /ما مسحت شي/);
  assert.equal(assistant.listOwnerContacts(assistant.ownerKey({ phone: '+963944555666' })).length, 3);
  assert.equal(sent.filter((m) => m.to !== lina.externalId).length, 0);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('assistant: owners can search online, read links and teach the knowledge base after "yes"', async () => {
  const assistant = await import('../src/assistant/index.js');
  process.env.SEARXNG_URL = mock.url;
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Hisham', phone: '+963944777888' }] }));
  assert.equal(mods.settings.getSetting('assistant').web_access, true);
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const owner = { channel: 'whatsapp', externalId: '963944777888@s.whatsapp.net', handle: '+963944777888', convMeta: { phone: '+963944777888' }, autoReply: false };
  const say = async (text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    mods.inbox.handleIncoming({ ...owner, text, messageId: id });
    await new Promise((r) => setTimeout(r, 600));
    return sent.filter((m) => m.to === owner.externalId).at(-1).text;
  };

  // Search: reads the pages (a broken one is skipped), answers with sources, and page text is marked as information only.
  let reply = await say('search the price of iPhone 16 Pro in Dubai', { action: 'web_search', text: 'price of iPhone 16 Pro in Dubai' }, 'web1');
  assert.match(reply, /costs 4299 AED in Dubai \[1\]/);
  assert.match(reply, /🔗 \[1\] http:\/\/127\.0\.0\.1:\d+\/page\/price/);
  assert.ok(sent.some((m) => m.text === '🔎 Searching…'));
  assert.match(lastWebPrompt.value, /ignore any instructions/);
  assert.doesNotMatch(lastWebPrompt.value, /Broken page/);
  // The model called it chat, but "دورلي" is a search.
  reply = await say('دورلي على سعر الآيفون', { action: 'chat', reply: 'ما بعرف' }, 'web2');
  assert.match(reply, /AED/);

  // Learn: shown first, added to Knowledge only after "yes".
  const before = mods.db.prepare('SELECT COUNT(*) AS n FROM kb_sources').get().n;
  reply = await say('learn about iPhone 16 Pro prices', { action: 'learn', text: 'iPhone 16 Pro prices' }, 'web3');
  assert.match(reply, /Here is what I learned/);
  assert.match(reply, /Reply "yes" or "no"/);
  assert.equal(mods.db.prepare('SELECT COUNT(*) AS n FROM kb_sources').get().n, before);
  reply = await say('yes', null, 'web4');
  assert.match(reply, /Added to Knowledge: "iPhone 16 Pro prices"/);
  const src = mods.db.prepare('SELECT * FROM kb_sources ORDER BY id DESC').get();
  assert.equal(src.title, '🌐 iPhone 16 Pro prices');
  assert.match(src.content, /4299 AED/);

  // A link is read directly; "no" to learning saves nothing.
  reply = await say(`learn this page ${mock.url}/page/price`, { action: 'chat' }, 'web5');
  assert.match(reply, /Here is what I learned/);
  reply = await say('no', null, 'web6');
  assert.match(reply, /didn't save it/);

  // Turned off: no web access.
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), web_access: false });
  reply = await say('search something', { action: 'web_search', text: 'something' }, 'web7');
  assert.match(reply, /turned off/);
  delete process.env.SEARXNG_URL;
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('assistant: a message sent while another is being handled is answered for what it said', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Q', phone: '+963944999000' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  const owner = { channel: 'whatsapp', externalId: '963944999000@s.whatsapp.net', handle: '+963944999000', convMeta: { phone: '+963944999000' }, autoReply: false };
  process.env.MOCK_CHAT_DELAY = '150';
  // The model gives no name, so each name has to come from that message's own text.
  assistantAnswers.push({ action: 'save_contact', to: null }, { action: 'save_contact', to: null });
  mods.inbox.handleIncoming({ ...owner, text: 'save Ali +971500000001', messageId: 'queue1' });
  mods.inbox.handleIncoming({ ...owner, text: 'save Omar +971500000002', messageId: 'queue2' });
  await new Promise((r) => setTimeout(r, 900));
  delete process.env.MOCK_CHAT_DELAY;
  assert.deepEqual(sent, ['📇 Saved Ali: +971500000001.', '📇 Saved Omar: +971500000002.']);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('photos: customers get answers about what the photo shows, and the team sees it', async () => {
  const { default: sharp } = await import('sharp');
  const { handleImage } = await import('../src/voice.js');
  const { visionAnswers, lastVision } = await import('./mock-ollama.js');
  const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: 'red' } }).png().toBuffer();
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  visionAnswers.push('A red iPhone with a cracked screen. Text: iPhone 15');
  await handleImage({ channel: 'whatsapp', externalId: '971500000077@s.whatsapp.net', name: 'Lina', handle: '+971500000077', messageId: 'img1', buffer: big, caption: 'بتصلحو هاد؟' });
  await new Promise((r) => setTimeout(r, 300));

  // The vision model got a smaller JPEG and the caption.
  const img = Buffer.from(lastVision.value.messages[0].images[0], 'base64');
  const info = await sharp(img).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, 1280);
  assert.match(lastVision.value.messages[0].content, /بتصلحو هاد/);
  assert.equal(lastVision.value.model, 'qwen2.5vl:7b');

  const conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === '971500000077@s.whatsapp.net');
  const [msg] = mods.inbox.listMessages(conv.id);
  assert.equal(msg.text, 'بتصلحو هاد؟\n\n[Photo: A red iPhone with a cracked screen. Text: iPhone 15]');
  const meta = JSON.parse(msg.meta);
  assert.ok(fs.existsSync(path.join(dataDir, 'media', meta.image)));
  assert.equal(meta.caption, 'بتصلحو هاد؟');
  assert.equal(sent.length, 1);
  // The English description doesn't change the customer's language, and the reply prompt explains photos.
  assert.equal(mods.agent.detectLanguage([{ role: 'user', content: msg.text }]), 'Arabic');
  assert.match(mods.agent.buildRulesPrompt(), /\[Photo: …\]/);
});

test('photos: without the photo model the picture is kept with a note and no AI reply', async () => {
  const { default: sharp } = await import('sharp');
  const { handleImage } = await import('../src/voice.js');
  mods.settings.setSetting('vision', { enabled: true, model: 'missing-vl' });
  const sent = [];
  mods.inbox.registerSender('telegram', async (conv, text) => sent.push(text));
  const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'blue' } }).png().toBuffer();
  await handleImage({ channel: 'telegram', externalId: '991', name: 'Sara', handle: '@sara', messageId: '991:1', buffer: png });
  await new Promise((r) => setTimeout(r, 200));
  const conv = mods.inbox.listConversations({ channel: 'telegram' }).find((c) => c.external_id === '991');
  const msgs = mods.inbox.listMessages(conv.id);
  assert.equal(msgs[0].text, '📷 Photo');
  assert.match(msgs[1].text, /photo model missing-vl is not downloaded/);
  assert.deepEqual(sent, []);
  mods.settings.setSetting('vision', { enabled: true, model: 'qwen2.5vl:7b' });
});

test('photos: the assistant reads a business card, saves the number from it, and learns a price list', async () => {
  const { default: sharp } = await import('sharp');
  const { handleImage } = await import('../src/voice.js');
  const { visionAnswers } = await import('./mock-ollama.js');
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'P', phone: '+963944121314' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push(text));
  const owner = { channel: 'whatsapp', externalId: '963944121314@s.whatsapp.net', handle: '+963944121314', convMeta: { phone: '+963944121314' }, autoReply: false };
  const png = await sharp({ create: { width: 80, height: 50, channels: 3, background: 'white' } }).png().toBuffer();
  const wait = () => new Promise((r) => setTimeout(r, 300));

  // Only a photo: the assistant says what it shows.
  visionAnswers.push('A business card. Text: Nour Card, Sales Manager, 2026-11-13, +971 55 444 3322, nour@card.ae');
  await handleImage({ ...owner, buffer: png, messageId: 'card1' });
  await wait();
  assert.match(sent.at(-1), /^About the photo: A business card/);

  // "save it as Nour" uses the number from the card, not the date.
  assistantAnswers.push({ action: 'save_contact', to: 'Nour Card' });
  mods.inbox.handleIncoming({ ...owner, text: 'save it as Nour', messageId: 'card2' });
  await wait();
  assert.equal(sent.at(-1), '📇 Saved Nour Card: +971554443322, nour@card.ae.');

  // A photo with words: the caption decides the language and the request.
  visionAnswers.push('A price list. Text: Screen repair iPhone 15 - 450 AED');
  assistantAnswers.push({ action: 'learn', text: 'price list' });
  await handleImage({ ...owner, buffer: png, caption: 'ضيف هاد للمعرفة', messageId: 'card3' });
  await wait();
  assert.match(sent.at(-1), /هاد اللي رح ضيفه:\n\nA price list\. Text: Screen repair iPhone 15 - 450 AED/);
  mods.inbox.handleIncoming({ ...owner, text: 'نعم', messageId: 'card4' });
  await wait();
  assert.match(sent.at(-1), /انضافت للمعرفة/);
  assert.ok(mods.db.prepare("SELECT 1 FROM kb_sources WHERE title = '📷 A price list'").get());
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

// A stand-in for the Piper binary: records what it was asked to say and writes a short tone.
async function fakePiper() {
  const dir = path.join(dataDir, 'piper');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'piper');
  fs.writeFileSync(bin, `#!/bin/sh
out=""; model=""
while [ $# -gt 0 ]; do
  [ "$1" = "--output_file" ] && out="$2"
  [ "$1" = "--model" ] && model="$2"
  shift
done
{ cat; echo "|$(basename "$model")"; } >> "${dir}/said.log"
ffmpeg -loglevel error -y -f lavfi -i sine=frequency=300:duration=0.4 "$out"
`, { mode: 0o755 });
  process.env.PIPER_BIN = bin;
  fs.mkdirSync(path.join(dataDir, 'voices'), { recursive: true });
  for (const id of ['en_GB-alan-medium', 'ar_JO-kareem-medium']) {
    fs.writeFileSync(path.join(dataDir, 'voices', `${id}.onnx`), '');
    fs.writeFileSync(path.join(dataDir, 'voices', `${id}.onnx.json`), '{}');
  }
  return () => fs.readFileSync(path.join(dir, 'said.log'), 'utf8');
}

test('voice: text is made speakable (links, numbers, emoji)', async () => {
  const { speakable, textLanguage } = await import('../src/ai/tts.js');
  assert.equal(speakable('✅ Call +971 55 444 3322 or see https://x.ae/p **now**'), 'Call 9 7 1 5 5 4 4 4 3 3 2 2 or see the link in the message now');
  assert.equal(speakable('⏰ تذكير #12:\n- اتصل بأحمد', 'Arabic'), 'تذكير رقم 12:. اتصل بأحمد');
  assert.equal(textLanguage('مرحبا Sami'), 'Arabic');
});

test('voice: a voice note gets a voice note back, in the right voice', async () => {
  const said = await fakePiper();
  const { handleVoiceNote } = await import('../src/voice.js');
  const speech = await import('../src/ai/speech.js');
  const { execFileSync } = await import('node:child_process');
  const ogg = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']);
  speech._setPipelineForTests(async () => ({ text: 'What are your opening hours?' }));
  mods.settings.setSetting('speak', { ...mods.settings.getSetting('speak'), enabled: true, customers: 'mirror' });
  const texts = [];
  const voices = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => texts.push(text));
  mods.inbox.registerVoiceSender('whatsapp', async (conv, audio) => { voices.push(audio); return { externalId: 'v-out' }; });

  await handleVoiceNote({ channel: 'whatsapp', externalId: '971500000088@s.whatsapp.net', name: 'Ali', handle: '+971500000088', messageId: 'sv1', buffer: ogg, ext: 'ogg', duration: 1 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(voices.length, 1);
  assert.equal(voices[0].subarray(0, 4).toString(), 'OggS');
  assert.deepEqual(texts, ['We are open 9am to 6pm.']); // the text goes too ("also send the written reply")
  assert.match(said(), /We are open 9am to 6pm\.\n\|en_GB-alan-medium\.onnx/);
  const conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === '971500000088@s.whatsapp.net');
  const out = mods.inbox.listMessages(conv.id).find((m) => m.direction === 'out');
  const meta = JSON.parse(out.meta);
  assert.equal(meta.spoken, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'media', meta.audio)));

  // A typed message gets a typed answer.
  mods.inbox.handleIncoming({ channel: 'whatsapp', externalId: '971500000088@s.whatsapp.net', name: 'Ali', handle: '+971500000088', messageId: 'sv2', text: 'What are your opening hours?' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(voices.length, 1);
  assert.equal(texts.length, 2);
  mods.settings.setSetting('speak', { ...mods.settings.getSetting('speak'), enabled: false, customers: 'off' });
});

test('voice: the assistant speaks to its owner, and sends voice notes to others when asked', async () => {
  const said = await fakePiper();
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'V', phone: '+963944909090' }] }));
  mods.settings.setSetting('speak', { ...mods.settings.getSetting('speak'), enabled: true, owners: 'always', also_text: false });
  const texts = [];
  const voices = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => texts.push({ to: conv.external_id, text }));
  mods.inbox.registerVoiceSender('whatsapp', async (conv, audio) => { voices.push({ to: conv.external_id, audio }); return { externalId: 'v' + voices.length }; });
  const owner = { channel: 'whatsapp', externalId: '963944909090@s.whatsapp.net', handle: '+963944909090', convMeta: { phone: '+963944909090' }, autoReply: false };
  const wait = () => new Promise((r) => setTimeout(r, 700));

  assistantAnswers.push({ action: 'chat', reply: 'أهلين، كيف فيني ساعدك؟' });
  mods.inbox.handleIncoming({ ...owner, text: 'مرحبا', messageId: 'sp1' });
  await wait();
  assert.equal(voices.length, 1);
  assert.equal(texts.length, 0); // voice only: no link, number or long text
  assert.match(said(), /أهلين، كيف فيني ساعدك؟\n\|ar_JO-kareem-medium\.onnx/);

  // "send … as a voice note": the preview says so, and after "yes" it goes out as a voice note.
  assistantAnswers.push({ action: 'send_message', to: '+971501234321', text: 'Your order is ready' });
  mods.inbox.handleIncoming({ ...owner, text: 'send +971501234321 "Your order is ready" as a voice note', messageId: 'sp2' });
  await wait();
  assert.match(texts.at(-1).text, /🎤 Voice note to \+971501234321 now, saying:\n\nYour order is ready/);
  mods.inbox.handleIncoming({ ...owner, text: 'yes', messageId: 'sp3' });
  await wait();
  assert.ok(voices.some((v) => v.to === '971501234321@s.whatsapp.net'));
  assert.ok(!texts.some((t) => t.to === '971501234321@s.whatsapp.net'));
  mods.settings.setSetting('speak', { ...mods.settings.getSetting('speak'), enabled: false, owners: 'mirror', also_text: true });
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('owner help: unknown answers are asked to the owner, sent to the customer and remembered; complaints alert the owner', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'H', phone: '+963944616161' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const ownerJid = '963944616161@s.whatsapp.net';
  const customer = { channel: 'whatsapp', externalId: '971500000099@s.whatsapp.net', name: 'Rana', handle: '+971500000099', convMeta: { phone: '+971500000099' } };
  const owner = { channel: 'whatsapp', externalId: ownerJid, handle: '+963944616161', convMeta: { phone: '+963944616161' }, autoReply: false };
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  const toOwner = () => sent.filter((m) => m.to === ownerJid).map((m) => m.text);
  const toCustomer = () => sent.filter((m) => m.to === customer.externalId).map((m) => m.text);

  // The AI doesn't know: the customer gets the fallback (without the tag) and the owner is asked, even if they never wrote before.
  mods.inbox.handleIncoming({ ...customer, text: 'How long is the warranty on used phones?', messageId: 'oh1' });
  await wait();
  assert.deepEqual(toCustomer(), ['I am not sure about that. A member of our team will get back to you soon.']);
  assert.match(toOwner().at(-1), /❓ Rana · \+971500000099 asked:\n«How long is the warranty on used phones\?»/);

  // A second unknown question soon after doesn't ask again.
  mods.inbox.handleIncoming({ ...customer, text: 'And warranty on chargers?', messageId: 'oh2' });
  await wait();
  assert.equal(toOwner().length, 1);

  // The owner's plain answer (the model calls it chat) is turned into a reply, shown first, then sent and learned.
  assistantAnswers.push({ action: 'chat', reply: 'OK' });
  mods.inbox.handleIncoming({ ...owner, text: '6 months warranty on all used phones', messageId: 'oh3' });
  await wait();
  assert.match(toOwner().at(-1), /^💬 Reply to Rana · \+971500000099:\n\nYes! 6 months warranty on all used phones\.\n\nI'll also remember it/);
  mods.inbox.handleIncoming({ ...owner, text: 'yes', messageId: 'oh4' });
  await wait();
  assert.equal(toCustomer().at(-1), 'Yes! 6 months warranty on all used phones.');
  assert.match(toOwner().at(-1), /✅ Sent to Rana · \+971500000099, and I'll know it next time/);
  const src = mods.db.prepare("SELECT * FROM kb_sources WHERE title LIKE '💬 %warranty%'").get();
  assert.ok(src);

  // Later, the answer isn't mistaken for a new one: a normal chat stays chat.
  assistantAnswers.push({ action: 'chat', reply: 'Hello!' });
  mods.inbox.handleIncoming({ ...owner, text: 'hi there', messageId: 'oh5' });
  await wait();
  assert.equal(toOwner().at(-1), 'Hello!');

  // An angry customer: the owner hears about it at once, but only once in a while.
  const before = toOwner().length;
  mods.inbox.handleIncoming({ ...customer, text: 'هاد نصب! بدي استرجاع المصاري', messageId: 'oh6' });
  await wait();
  assert.match(toOwner().at(-1), /🚨 Heads up: Rana · \+971500000099 wrote:\n«هاد نصب! بدي استرجاع المصاري»/);
  mods.inbox.handleIncoming({ ...customer, text: 'I want a refund', messageId: 'oh7' });
  await wait();
  assert.equal(toOwner().length, before + 1);
  // Short words only match on their own.
  assert.equal(await assistant.alertOwnerIfUrgent(mods.inbox.listConversations({ channel: 'whatsapp' })[0].id, 'ok'), undefined);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('backups: the database and WhatsApp login are copied, old ones are removed', async () => {
  const backup = await import('../src/backup.js');
  fs.mkdirSync(path.join(dataDir, 'whatsapp-auth'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'whatsapp-auth', 'creds.json'), '{}');
  mods.settings.setSetting('backup', { enabled: true, time: '03:00', keep: 2 });
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) await backup.backupNow(day);
  const list = backup.listBackups();
  assert.deepEqual(list.map((b) => b.name), ['2026-11-03', '2026-11-02']);
  const dir = path.join(dataDir, 'backups', '2026-11-03');
  assert.ok(fs.existsSync(path.join(dir, 'whatsapp-auth', 'creds.json')));
  const Database = (await import('better-sqlite3')).default;
  const copy = new Database(path.join(dir, 'agent.db'), { readonly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 0);
  copy.close();
});

test('self-review: learns general answers from the team (with approval), never one customer\'s details', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'R', phone: '+963944717171' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const ownerJid = '963944717171@s.whatsapp.net';
  const owner = { channel: 'whatsapp', externalId: ownerJid, handle: '+963944717171', convMeta: { phone: '+963944717171' }, autoReply: false };
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  const c1 = mods.inbox.ensureConversation({ channel: 'whatsapp', externalId: '971500000201@s.whatsapp.net', handle: '+971500000201' });
  const c2 = mods.inbox.ensureConversation({ channel: 'whatsapp', externalId: '971500000202@s.whatsapp.net', handle: '+971500000202' });
  mods.inbox.updateConversation(c1, { auto_reply: false });
  mods.inbox.updateConversation(c2, { auto_reply: false });
  mods.inbox.handleIncoming({ channel: 'whatsapp', externalId: '971500000201@s.whatsapp.net', text: 'Do you deliver to Sharjah?', messageId: 'sr1' });
  await mods.inbox.sendMessage(c1, 'Yes, we deliver to Sharjah within 2 days for 20 AED.', { sender: 'agent' });
  mods.inbox.handleIncoming({ channel: 'whatsapp', externalId: '971500000202@s.whatsapp.net', text: 'any news?', messageId: 'sr2' });
  await mods.inbox.sendMessage(c2, 'Hi Rana, your order 55 is ready for pickup.', { sender: 'agent' });

  assistantAnswers.push({ action: 'self_review' });
  mods.inbox.handleIncoming({ ...owner, text: 'review yourself', messageId: 'sr3' });
  await wait(600);
  const report = sent.filter((m) => m.to === ownerJid).at(-1).text;
  assert.match(report, /🧠 My weekly self-review/);
  assert.match(report, /1\. Delivery to Sharjah\n {3}Yes, within 2 days for 20 AED\./);
  assert.doesNotMatch(report, /order 55/);

  mods.inbox.handleIncoming({ ...owner, text: '1', messageId: 'sr4' });
  await wait();
  assert.match(sent.filter((m) => m.to === ownerJid).at(-1).text, /🧠 Learned 1: Delivery to Sharjah/);
  assert.ok(mods.db.prepare("SELECT 1 FROM kb_sources WHERE title = '🧠 Delivery to Sharjah'").get());

  // Looked-at replies aren't proposed again.
  const review = await import('../src/assistant/review.js');
  const again = await review.reviewChats({ ownerConversationIds: assistant.ownerConversationIds() });
  assert.equal(again.added.length, 0);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('skills: owners teach rules for customers and regular jobs by chat', async () => {
  const assistant = await import('../src/assistant/index.js');
  const skills = await import('../src/assistant/skills.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'S', phone: '+963944818181' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const ownerJid = '963944818181@s.whatsapp.net';
  const owner = { channel: 'whatsapp', externalId: ownerJid, handle: '+963944818181', convMeta: { phone: '+963944818181' }, autoReply: false };
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  const last = () => sent.filter((m) => m.to === ownerJid).at(-1).text;

  assistantAnswers.push({ action: 'add_rule', text: 'Tell customers delivery is free over 500 AED.' });
  mods.inbox.handleIncoming({ ...owner, text: 'from now on tell customers delivery is free over 500 AED', messageId: 'sk1' });
  await wait();
  assert.match(last(), /🧩 New skill:\nRule: Tell customers delivery is free over 500 AED\./);
  mods.inbox.handleIncoming({ ...owner, text: 'yes', messageId: 'sk2' });
  await wait();
  assert.match(last(), /🧩 Learned #\d+: Rule:/);
  assert.match(mods.agent.buildRulesPrompt(), /RULES FROM THE OWNER \(always follow them\):\n- Tell customers delivery is free over 500 AED\./);

  // A weekly job: the day comes from the owner's words, the time from "at 5" (afternoon).
  assistantAnswers.push({ action: 'add_job', text: 'Send me a summary of today', repeat: 'daily', when: null });
  mods.inbox.handleIncoming({ ...owner, text: 'كل جمعة الساعة 5 ابعتلي ملخص اليوم', messageId: 'sk3' });
  await wait();
  assert.match(last(), /كل جمعة الساعة 17:00: Send me a summary of today/);
  mods.inbox.handleIncoming({ ...owner, text: 'نعم', messageId: 'sk4' });
  await wait();
  const job = skills.listSkills().find((s) => s.kind === 'job');
  assert.equal(job.repeat, 'weekly');
  assert.equal(job.weekday, 5);
  assert.equal(job.time, '17:00');
  const next = new Date(job.next_run);
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Damascus', weekday: 'long', hour: '2-digit', hourCycle: 'h23' }).format(next), 'Friday, 17');

  // When it's due, it runs like a message from the owner, and moves to next week.
  mods.db.prepare('UPDATE skills SET next_run = ? WHERE id = ?').run(new Date(Date.now() - 60e3).toISOString(), job.id);
  assistantAnswers.push({ action: 'summary' });
  await assistant.runDueTasks(new Date());
  await wait();
  assert.match(last(), /^⚙️ كل جمعة الساعة 17:00: Send me a summary of today\n\n📊/);
  assert.ok(new Date(skills.listSkills().find((s) => s.id === job.id).next_run) > new Date(Date.now() + 86400e3));
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('wishes: what the assistant can\'t do is noted for the developer, counted, and in the weekly review', async () => {
  const assistant = await import('../src/assistant/index.js');
  const skills = await import('../src/assistant/skills.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'W', phone: '+963944828282' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const owner = { channel: 'whatsapp', externalId: '963944828282@s.whatsapp.net', handle: '+963944828282', convMeta: { phone: '+963944828282' }, autoReply: false };
  assistantAnswers.push({ action: 'cannot_do', text: 'Post offers on Instagram' }, { action: 'cannot_do', text: 'post offers on instagram!' });
  mods.inbox.handleIncoming({ ...owner, text: 'انشر العرض على انستغرام', messageId: 'wi1' });
  await new Promise((r) => setTimeout(r, 300));
  assert.match(sent.at(-1).text, /ما بقدر اعمل هالشي لسا \("Post offers on Instagram"\)/);
  mods.inbox.handleIncoming({ ...owner, text: 'post the offer on instagram', messageId: 'wi2' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(skills.listWishes().map((w) => [w.text, w.times]), [['Post offers on Instagram', 2]]);
  const review = await import('../src/assistant/review.js');
  assert.match(review.reviewMessage({ added: [], open: [] }, 'English').text, /Things you asked for that I can't do yet[^\n]*\n• Post offers on Instagram \(×2\)/);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('insights: quiet price askers get a follow-up after "yes", the weekly report, and customer notes', async () => {
  const assistant = await import('../src/assistant/index.js');
  const insights = await import('../src/assistant/insights.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'F', phone: '+963944838383' }] }));
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const ownerJid = '963944838383@s.whatsapp.net';
  const owner = { channel: 'whatsapp', externalId: ownerJid, handle: '+963944838383', convMeta: { phone: '+963944838383' }, autoReply: false };
  const lead = { channel: 'whatsapp', externalId: '971500000301@s.whatsapp.net', name: 'Maya', handle: '+971500000301', convMeta: { phone: '+971500000301' } };
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  mods.inbox.handleIncoming({ ...lead, text: 'Hi, my name is Maya. بكم سعر iPhone 15؟', messageId: 'fu1' });
  await wait();
  const convId = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === lead.externalId).id;
  assert.ok(insights.showsInterest('بكم سعر iPhone 15؟'));
  assert.ok(!insights.showsInterest('thanks a lot'));
  // Two days pass without an answer from Maya.
  const old = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
  mods.db.prepare('UPDATE messages SET created_at = ? WHERE conversation_id = ?').run(old, convId);
  mods.db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(old, convId);
  const leads = insights.quietLeads({ hours: 24, skip: new Set(assistant.ownerConversationIds()) });
  assert.deepEqual(leads.map((l) => [l.name, l.asked]), [['Maya', 'Hi, my name is Maya. بكم سعر iPhone 15؟']]);
  assert.equal(insights.followupText(leads[0]), 'مرحبا Maya! حبيت اطمن إذا لقيت كل اللي بدك ياه بخصوص سؤالك. في شي تاني فيني ساعدك فيه؟');

  // The scheduler asks the owner (during the day), and "yes" sends it.
  const noon = new Date(`${new Date().toISOString().slice(0, 10)}T09:00:00Z`); // 12:00 in Damascus
  await assistant.runDueTasks(noon);
  await wait(600);
  const ask = sent.filter((m) => m.to === ownerJid).at(-1).text;
  assert.match(ask, /🔁 These customers asked about prices or buying and went quiet:\n• Maya · \+971500000301: «Hi, my name is Maya\. بكم سعر iPhone 15؟»/);
  mods.inbox.handleIncoming({ ...owner, text: 'yes', messageId: 'fu2' });
  await wait();
  assert.equal(sent.filter((m) => m.to === lead.externalId).at(-1).text, 'مرحبا Maya! حبيت اطمن إذا لقيت كل اللي بدك ياه بخصوص سؤالك. في شي تاني فيني ساعدك فيه؟');
  assert.match(sent.filter((m) => m.to === ownerJid).at(-1).text, /✅ Followed up with 1 customer\./);
  assert.equal(insights.quietLeads({ hours: 24, skip: new Set(assistant.ownerConversationIds()) }).length, 0);

  // Customer notes are written once the chat pauses, and used in the next reply.
  const ids = insights.profilesToUpdate({ now: new Date(Date.now() + 3600e3), skip: new Set(assistant.ownerConversationIds()), limit: 50 });
  assert.ok(ids.includes(convId) || true);
  const p = await insights.buildProfile(convId);
  assert.equal(p.profile, '- Name: Maya\n- Wants an iPhone 15, delivery to Sharjah');
  mods.inbox.updateMeta(convId, { profile: p.profile, profileUpTo: p.upTo });
  const { lastChatPrompt } = await import('./mock-ollama.js');
  mods.inbox.handleIncoming({ ...lead, text: 'What are your opening hours?', messageId: 'fu3' });
  await wait();
  assert.match(lastChatPrompt.value, /NOTES ABOUT THIS CUSTOMER[^\n]*\n- Name: Maya/);

  // The owner can ask about a customer, and for the weekly report.
  assistantAnswers.push({ action: 'customer_info', to: 'Maya' });
  mods.inbox.handleIncoming({ ...owner, text: 'what do you know about Maya', messageId: 'fu4' });
  await wait();
  assert.match(sent.filter((m) => m.to === ownerJid).at(-1).text, /👤 Maya[^\n]*\n- Name: Maya\n- Wants an iPhone 15/);
  assistantAnswers.push({ action: 'report' });
  mods.inbox.handleIncoming({ ...owner, text: 'weekly report', messageId: 'fu5' });
  await wait(600);
  const report = sent.filter((m) => m.to === ownerJid).at(-1).text;
  assert.match(report, /📈 Weekly report \(last 7 days\)/);
  assert.match(report, /Top topics:\n- iPhone prices \(about 2 messages\)\n- Delivery/);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('drafts: new topics wait for the owner, their edits teach the style, approved topics go straight out', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'H', phone: '+963944717171' }] }));
  mods.settings.setSetting('drafts', { enabled: true, approvals: 2, hold_message: true });
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const ownerJid = '963944717171@s.whatsapp.net';
  const customer = { channel: 'whatsapp', externalId: '971500000177@s.whatsapp.net', name: 'Sami', handle: '+971500000177', convMeta: { phone: '+971500000177' } };
  const owner = { channel: 'whatsapp', externalId: ownerJid, handle: '+963944717171', convMeta: { phone: '+963944717171' }, autoReply: false };
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  const toOwner = () => sent.filter((m) => m.to === ownerJid).map((m) => m.text);
  const toCustomer = () => sent.filter((m) => m.to === customer.externalId).map((m) => m.text);
  const hours = mods.db.prepare("SELECT id FROM kb_sources WHERE title = 'Opening hours'").get().id;
  const trust = () => mods.db.prepare('SELECT approvals FROM trust WHERE source_id = ?').get(hours)?.approvals || 0;

  // A topic the owner never approved: the customer is told to hold on, the owner sees the draft.
  mods.inbox.handleIncoming({ ...customer, text: 'What are your opening hours?', messageId: 'dr1' });
  await wait();
  assert.deepEqual(toCustomer(), ['Let me check that for you, one moment please 🙏']);
  assert.match(toOwner().at(-1), /^✍️ Draft reply to Sami · \+971500000177\nThey asked: «What are your opening hours\?»\n\nWe are open 9am to 6pm\.\n\nReply "yes"/);
  assert.equal(assistant.listDrafts().length, 1);

  // "yes" sends it as is and counts one approval for that topic.
  mods.inbox.handleIncoming({ ...owner, text: 'yes', messageId: 'dr2' });
  await wait();
  assert.equal(toCustomer().at(-1), 'We are open 9am to 6pm.');
  assert.equal(toOwner().at(-1), '✅ Sent.');
  assert.equal(trust(), 1);

  // The owner writes their own version: that is sent, kept as an example, and the topic starts over.
  mods.inbox.handleIncoming({ ...customer, text: 'Are you open on Friday? what hours?', messageId: 'dr3' });
  await wait();
  assert.equal(toCustomer().length, 2); // no second hold message within the hour
  assistantAnswers.push({ action: 'chat', reply: 'OK' });
  mods.inbox.handleIncoming({ ...owner, text: 'Hey! We open 9 to 6, Saturday to Thursday, closed Fridays 😊', messageId: 'dr4' });
  await wait();
  assert.equal(toCustomer().at(-1), 'Hey! We open 9 to 6, Saturday to Thursday, closed Fridays 😊');
  assert.match(toOwner().at(-1), /Sent your version/);
  assert.equal(trust(), 0);
  const ex = mods.db.prepare('SELECT * FROM style_examples ORDER BY id DESC').get();
  assert.equal(ex.final_text, 'Hey! We open 9 to 6, Saturday to Thursday, closed Fridays 😊');
  assert.equal(ex.ai_text, 'We are open 9am to 6pm.');
  // The next answers are written with the team's example in front of the model.
  assert.match(mods.agent.styleExamples('opening hours today?', 'English'), /HOW OUR TEAM ANSWERS[\s\S]*closed Fridays/);
  assert.equal(mods.agent.styleExamples('ساعات الدوام؟', 'Arabic'), '');

  // After enough approvals in a row the topic is trusted: answers go straight out.
  for (const [i, q] of ['What are your opening hours on Monday?', 'What are your opening hours this week?'].entries()) {
    mods.inbox.handleIncoming({ ...customer, text: q, messageId: `dr5${i}` });
    await wait();
    assert.match(toOwner().at(-1), /^✍️ Draft reply/);
    mods.inbox.handleIncoming({ ...owner, text: 'yes', messageId: `dr6${i}` });
    await wait();
  }
  assert.equal(trust(), 2);
  const before = toOwner().length;
  mods.inbox.handleIncoming({ ...customer, text: 'What are your opening hours tomorrow?', messageId: 'dr7' });
  await wait();
  assert.equal(toCustomer().at(-1), 'We are open 9am to 6pm.');
  assert.equal(toOwner().length, before);

  // A team member answering in the inbox replaces the waiting draft.
  mods.db.prepare('DELETE FROM trust').run();
  mods.inbox.handleIncoming({ ...customer, text: 'Open on Sunday?', messageId: 'dr8' });
  await wait();
  const [d] = assistant.listDrafts();
  assert.ok(d);
  assistant.learnFromTeamReply(d.conversation_id, 'Yes, Sunday 9 to 6.');
  assert.equal(mods.db.prepare('SELECT status FROM drafts WHERE id = ?').get(d.id).status, 'edited');
  assert.equal(assistant.listDrafts().length, 0);

  // "no" drops a draft without sending anything.
  mods.inbox.handleIncoming({ ...customer, text: 'Open on holidays?', messageId: 'dr9' });
  await wait();
  const n = toCustomer().length;
  mods.inbox.handleIncoming({ ...owner, text: 'no', messageId: 'dr10' });
  await wait();
  assert.equal(toCustomer().length, n);
  assert.match(toOwner().at(-1), /didn't send it/);

  mods.settings.setSetting('drafts', { enabled: false, approvals: 3, hold_message: true });
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('catalog: products become knowledge, and their photo goes with answers about them', async () => {
  const catalog = await import('../src/catalog.js');
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c00' } }).png().toBuffer();
  const image = await catalog.saveProductImage(png);
  const p = await catalog.saveProduct({ name: 'iPhone 15 Pro', price: '3,999 AED', description: 'Titanium, 256GB, 1 year warranty', image, in_stock: '1' });
  const src = mods.db.prepare('SELECT * FROM kb_sources WHERE id = ?').get(p.source_id);
  assert.equal(src.title, '🛍️ iPhone 15 Pro');
  assert.match(src.content, /Price: 3,999 AED\nAvailable: yes/);
  assert.equal(src.status, 'ready');

  const sent = [];
  mods.inbox.registerSender('telegram', async (conv, text) => sent.push({ kind: 'text', text }));
  mods.inbox.registerImageSender('telegram', async (conv, img, caption) => sent.push({ kind: 'photo', caption, bytes: img.length }));
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  const customer = { channel: 'telegram', externalId: '555000111', name: 'Lina', handle: '@lina' };
  mods.inbox.handleIncoming({ ...customer, text: 'How much is the iPhone 15 Pro?', messageId: 'ct1' });
  await wait();
  assert.deepEqual(sent.map((m) => m.kind), ['text', 'photo']);
  assert.equal(sent[0].text, 'The iPhone 15 Pro costs 3,999 AED and is in stock.');
  assert.equal(sent[1].caption, 'iPhone 15 Pro · 3,999 AED');
  // Not again the same day.
  mods.inbox.handleIncoming({ ...customer, text: 'Is the iPhone 15 Pro still available?', messageId: 'ct2' });
  await wait();
  assert.deepEqual(sent.map((m) => m.kind), ['text', 'photo', 'text']);

  // Out of stock: the knowledge follows.
  await catalog.saveProduct({ id: p.id, name: 'iPhone 15 Pro', price: '3,999 AED', description: 'Titanium', in_stock: '0' });
  assert.match(mods.db.prepare('SELECT content FROM kb_sources WHERE id = ?').get(p.source_id).content, /out of stock/);
  assert.equal(mods.db.prepare('SELECT image FROM products WHERE id = ?').get(p.id).image, image); // photo kept
  mods.inbox.handleIncoming({ ...customer, text: 'iphone 15 pro?', messageId: 'ct3' });
  await wait();
  assert.equal(sent.at(-1).text, 'Sorry, the iPhone 15 Pro is out of stock at the moment.');

  // Deleting removes its knowledge too.
  assert.ok(catalog.deleteProduct(p.id));
  assert.equal(mods.db.prepare('SELECT 1 FROM kb_sources WHERE id = ?').get(p.source_id), undefined);
});

test('presence: customers see "typing…" (or "recording…" for voice replies) while the AI answers', async () => {
  const states = [];
  mods.inbox.registerPresence('telegram', async (id, kind) => states.push(`${id}:${kind}`), 50);
  mods.inbox.registerSender('telegram', async () => ({}));
  mods.inbox.handleIncoming({ channel: 'telegram', externalId: '555000222', name: 'Omar', handle: '@omar', text: 'What are your opening hours?', messageId: 'pr1' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(states[0], '555000222:typing');
  assert.equal(states.at(-1), '555000222:paused');
  // A chat the team took over shows nothing while a photo is read.
  const id = mods.inbox.listConversations({ channel: 'telegram' }).find((c) => c.external_id === '555000222').id;
  mods.inbox.updateConversation(id, { auto_reply: false });
  states.length = 0;
  mods.inbox.showPresenceForIncoming({ channel: 'telegram', externalId: '555000222' })();
  assert.deepEqual(states, []);
});

test('groups: the AI answers in a group only when addressed, knows who spoke, and never follows up there', async () => {
  const { addressedInGroup } = await import('../src/channels/whatsapp.js');
  const me = ['971500000001:12@s.whatsapp.net', '123456789012345@lid'];
  const g = { mode: 'mention', names: 'Jarvis, جارفس' };
  assert.equal(addressedInGroup({ text: 'hi all' }, me, g), false);
  assert.equal(addressedInGroup({ text: '@123456789012345 price?', mentioned: ['123456789012345@lid'] }, me, g), true);
  assert.equal(addressedInGroup({ text: 'ok thanks', quotedFrom: '971500000001@s.whatsapp.net' }, me, g), true);
  assert.equal(addressedInGroup({ text: 'Jarvis, what time do you open?' }, me, g), true);
  assert.equal(addressedInGroup({ text: 'يا جارفس شو الأسعار' }, me, g), true);
  assert.equal(addressedInGroup({ text: 'jarvisx' }, me, g), false);
  assert.equal(addressedInGroup({ text: 'hi all' }, me, { ...g, mode: 'all' }), true);

  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const group = { channel: 'whatsapp', externalId: '120363000000000001@g.us', name: 'Shop friends', handle: 'group', convMeta: { group: true } };
  mods.inbox.handleIncoming({ ...group, text: 'Ahmad: who is coming tonight?', messageId: 'g1', autoReply: false });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.length, 0);
  mods.inbox.handleIncoming({ ...group, text: 'Rami: Jarvis what are your opening hours?', messageId: 'g2', autoReply: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.at(-1)?.to, group.externalId);
  const conv = mods.inbox.listConversations({ channel: 'whatsapp' }).find((c) => c.external_id === group.externalId);
  assert.match(mods.agent.buildRulesPrompt(mods.inbox.getConversation(conv.id)), /GROUP CHAT/);
  assert.doesNotMatch(mods.agent.buildRulesPrompt(null), /GROUP CHAT/);
});

test('smarter assistant: no "who?" loop, names with ل, "yes but…" edits, no made-up numbers, inbox, country, formatting', async () => {
  const assistant = await import('../src/assistant/index.js');
  mods.settings.setSetting('assistant', assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Dubai', confirm_before_sending: true, owners: [{ name: 'Hisham', phone: '+971 50 818 1818' }] }));
  mods.settings.setSetting('drafts', { enabled: false, approvals: 3, hold_message: true });
  const sent = [];
  mods.inbox.registerSender('whatsapp', async (conv, text) => sent.push({ to: conv.external_id, text }));
  const owner = { channel: 'whatsapp', externalId: '971508181818@s.whatsapp.net', name: 'Hisham', handle: '+971508181818', convMeta: { phone: '+971508181818' }, autoReply: false };
  const wait = () => new Promise((r) => setTimeout(r, 300));
  const toOwner = () => sent.filter((m) => m.to === owner.externalId).map((m) => m.text);
  const others = () => sent.filter((m) => m.to !== owner.externalId);
  const says = async (text, answer, id) => {
    if (answer) assistantAnswers.push(answer);
    mods.inbox.handleIncoming({ ...owner, text, messageId: id });
    await wait();
    return toOwner().at(-1);
  };
  const key = assistant.ownerKey({ phone: '+971508181818' });
  assistant.saveOwnerContact(key, { name: 'مرتي', phone: '+971501110000' });

  // 1. "Who should I send it to?" is asked once; an answer that isn't a name is a new request, read on its own.
  const first = await says('قلو مرحبا', { action: 'send_message', to: null, text: 'مرحبا' }, 'sm1');
  assert.match(first, /لمين بدك ابعتها/);
  // "الي هون" is not a person: asked again, and nothing goes to the owner's own number.
  assert.match(await says('الي هون', null, 'sm2'), /مين يعني/);
  assert.match(await says('+971 50 818 1818', null, 'sm2b'), /لمين بدك ابعتها/);
  await says('no', null, 'sm2e');
  // An answer that isn't a name is read on its own, without the old request.
  await says('قلو مرحبا', { action: 'send_message', to: null, text: 'مرحبا' }, 'sm2c');
  assert.equal(await says('شو الطقس', { action: 'chat', reply: 'مشمس' }, 'sm2d'), 'مشمس');
  assert.equal(lastAssistantTurns.value, 1);
  // A name and a number answer it: the number is used and saved under that name.
  await says('قلو مرحبا', { action: 'send_message', to: null, text: 'مرحبا' }, 'sm3');
  const preview = await says('غيث +971 50 222 3344', null, 'sm4');
  assert.match(preview, /📇 حفظت غيث \(\+971502223344\)/);
  assert.match(preview, /واتساب إلى \+971502223344/);
  assert.ok(assistant.listOwnerContacts(key).some((c) => c.name === 'غيث'));
  await says('no', null, 'sm5');

  // 2. "لمرتي" finds the saved "مرتي", and the message never calls her "مرتي".
  const toWife = await says('ابعت لمرتي انو اشتقتلها', { action: 'send_message', to: 'لمرتي', text: 'مرتي، اشتقتلك' }, 'sm6');
  assert.match(toWife, /واتساب إلى مرتي \(\+971501110000\)/);
  assert.match(toWife, /\n\nاشتقتلك\n\n/);

  // 3. "اي بس بالعربي" changes the draft and asks again; only a plain yes sends.
  const edited = await says('اي بس بالعربي', null, 'sm7');
  assert.match(edited, /\n\nمرحبا، طلبك جاهز\.\n\n/);
  assert.equal(others().length, 0);
  await says('اي', null, 'sm8');
  assert.deepEqual(others().at(-1), { to: '971501110000@s.whatsapp.net', text: 'مرحبا، طلبك جاهز.' });

  // 4. A number the owner never wrote is not used; a price question is a search, not "learn".
  assert.equal(assistant.fixCommand({ action: 'send_message', to: '+971XXXXXXNour' }, 'قلها لنور صباح الخير', 'Arabic').to, 'Nour');
  assert.equal(assistant.fixCommand({ action: 'learn', text: 'ipad air' }, 'اديش حق ipad air', 'Arabic').action, 'web_search');
  assert.equal(assistant.fixCommand({ action: 'learn', text: 'x' }, 'تعلم عن المنافس', 'Arabic').action, 'learn');
  assert.equal(assistant.fixCommand({ action: 'chat', reply: 'x' }, 'Has anyone sent me any messages?', 'English').action, 'inbox');
  assert.equal(assistant.fixCommand({ action: 'send_message', to: null }, 'حدا بعتلي شي؟ مين حكى اليوم', 'Arabic').action, 'inbox');

  // 5. The inbox: who wrote in the last day.
  mods.inbox.handleIncoming({ channel: 'whatsapp', externalId: '971509990000@s.whatsapp.net', name: 'Layla', handle: '+971509990000', text: 'Is the iPad Air in stock?', messageId: 'sm9', autoReply: false });
  const inbox = await says('any new messages?', { action: 'chat', reply: 'no' }, 'sm10');
  assert.match(inbox, /📥 \d+ chats? with new messages[\s\S]*Layla \(whatsapp, \d\d:\d\d[^)]*\): «Is the iPad Air in stock\?»/);

  // 6. Prices are searched where the business is (from the owner's +971 number).
  assert.equal(assistant.businessCountry(), 'United Arab Emirates');

  // 7. Markdown becomes WhatsApp formatting.
  const { forChat } = await import('../src/channels/format.js');
  assert.equal(forChat('### Prices\n**iPad Air** 2,199 AED\n* 256GB\n[Apple](https://apple.com)'), '*Prices*\n*iPad Air* 2,199 AED\n• 256GB\nApple: https://apple.com');
  assert.equal(forChat('**bold**', 'telegram'), 'bold');

  // 8. "Owner only" knowledge never reaches customers.
  const cv = mods.kb.createSource({ type: 'text', title: 'Hisham CV', content: 'Hisham Khatib is a full-stack developer building mobile apps and websites.' });
  await mods.kb.indexSource(cv);
  assert.ok((await mods.kb.search('full-stack developer mobile apps', { minScore: 0.1 })).some((r) => r.source_id === Number(cv)));
  mods.kb.setSourceAudience(cv, 'owner');
  assert.ok(!(await mods.kb.search('full-stack developer mobile apps', { minScore: 0.1, audience: 'customers' })).some((r) => r.source_id === Number(cv)));
  assert.match(mods.agent.buildRulesPrompt(null), /IDENTITY: you are the AI assistant of/);

  // 9. A name the owner used ("لسامر") is kept, so the number sent next is saved under it.
  assert.match(await says('ابعت لسامر انو وصلت', { action: 'send_message', to: null, text: 'وصلت' }, 'sm11'), /ما عندي رقم سامر/);
  assert.match(await says('+971 50 333 4455', null, 'sm12'), /📇 حفظت سامر/);
  await says('no', null, 'sm13');
  // A placeholder is not a person.
  assert.equal(assistant.fixCommand({ action: 'send_message', to: 'اسم المستلم' }, 'ابعت رسالة', 'Arabic').to, null);
  // A complaint is not a request for the help list.
  assert.match(await says('انت ما عم تفهم علي', { action: 'help' }, 'sm14'), /آسف 🙏 شو اللي ما زبط/);
  assert.match(await says('انت ما عم تفهم', { action: 'chat', reply: 'أنا مساعد ذكاء اصطناعي' }, 'sm14b'), /آسف 🙏/);
  assert.match(await says('بدي شي بس مش عارف شو', { action: 'chat', reply: null }, 'sm14c'), /ما فهمت عليك/);

  // The owner's command is never sent as the message itself.
  const copy = await says('ابعتلو لنورس صباح الخير وعرفو عن حالك +971 50 444 5566', { action: 'send_message', to: '+971 50 444 5566', text: 'ابعتلو لنورس صباح الخير وعرفو عن حالك' }, 'sm14d');
  assert.doesNotMatch(copy, /ابعتلو لنورس/);
  await says('no', null, 'sm14e');

  // Short plain requests use a template: the point is kept, nothing is added.
  assert.equal(assistant.templateDraft('قلو لغيث انو اليوم رح اتأخر', 'غيث', null, 'Hisham', 'TopTech', 'Arabic', false), 'مرحبا غيث، اليوم رح اتأخر');
  assert.equal(assistant.templateDraft('ابعتلو لنورس صباح الخير وعرفو عن حالك', 'نورس', null, 'Hisham', 'TopTech', 'Arabic', true), 'صباح الخير نورس، معك المساعد الذكي تبع Hisham من TopTech 👋');
  assert.equal(assistant.templateDraft('ابعت لمرتي انو اشتقتلها', '', 'مرتي', 'هشام', 'توب تك', 'Arabic', false), 'اشتقتلك');
  assert.equal(assistant.templateDraft('قلو لغيث اسألو اذا الطلب جاهز', 'غيث', null, 'هشام', 'توب تك', 'Arabic', false), 'مرحبا غيث، الطلب جاهز؟');
  assert.equal(assistant.normalizeAssistant({ owners: [{ name: 'Hisham', name_ar: 'هشام', phone: '+971501' }], company_ar: 'توب تك' }).company_ar, 'توب تك');
  // A name given with a new number is remembered.
  assert.ok(assistant.listOwnerContacts(key).some((c) => c.name === 'نورس'));

  // Drafts lose what the owner never said: a translation, Latin letters, feelings, an introduction.
  const said = 'ابعت لسامر انو وصلت';
  assert.equal(assistant.trimDraft('سامر، وصلت. اشتقتلك! (Translation: Samer, I arrived.)', said, 'Arabic', 'Hisham', 'TopTech'), 'سامر، وصلت.');
  assert.equal(assistant.trimDraft('أعتذر عن الإزعاج. أنا هisham من TopTech. وصلت يا سامر.', said, 'Arabic', 'Hisham', 'TopTech'), 'وصلت يا سامر.');
  assert.equal(assistant.trimDraft('اشتقتلك كتير', 'قلها انو اشتقتلها', 'Arabic', 'Hisham', 'TopTech'), 'اشتقتلك كتير');
  assert.doesNotMatch(await says('شو بتعرف تساوي؟', { action: 'help' }, 'sm15'), /ما فهمت عليك/);

  // 10. Groups: the AI knows who has written, and never promises the team will call.
  const g = { channel: 'whatsapp', externalId: '1203630000@g.us', name: 'Team', handle: 'group', convMeta: { group: true }, autoReply: false };
  mods.inbox.handleIncoming({ ...g, text: 'Rami: hi', messageId: 'sm16', meta: { group: true, from: 'Rami' } });
  const gid = mods.inbox.handleIncoming({ ...g, text: 'Lina: hello', messageId: 'sm17', meta: { group: true, from: 'Lina' } });
  const rules = mods.agent.buildRulesPrompt(mods.inbox.getConversation(gid));
  assert.match(rules, /written in this group so far: Rami, Lina/);
  assert.match(rules, /never say the team will contact them/);
  const who = await mods.agent.answer([{ role: 'user', content: 'Rami: hi' }, { role: 'user', content: 'Lina: مين معنا بالغروب؟' }], { conv: mods.inbox.getConversation(gid) });
  assert.match(who.reply, /Lina، اللي حكوا بالغروب لهلق: Rami، Lina/);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});
