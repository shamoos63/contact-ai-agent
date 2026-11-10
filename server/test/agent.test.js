import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockOllama, assistantAnswers } from './mock-ollama.js';

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
  assert.match(reply, /Hi, I am the assistant\. كيفك؟/);
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
  assert.match(reply, /مسحت نور/);
  assert.equal(assistant.listOwnerContacts(assistant.ownerKey({ phone: '+963944111222' })).length, 1);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});
