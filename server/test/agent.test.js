import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockOllama } from './mock-ollama.js';

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
  const prompt = mods.agent.buildSystemPrompt([]);
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
