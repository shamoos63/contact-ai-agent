import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockOllama, assistantAnswers } from './mock-ollama.js';

// The Android companion app's API: the owner's assistant chat from the phone, missed calls, call notes.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-device-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-pass';

let mock, server, base, cookie, mods;
const sent = [];

before(async () => {
  mock = await startMockOllama();
  process.env.OLLAMA_URL = mock.url;
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { ensureAdmin } = await import('../src/auth.js');
  const { api } = await import('../src/routes/api.js');
  mods = {
    settings: await import('../src/settings.js'),
    inbox: await import('../src/inbox.js'),
    assistant: await import('../src/assistant/index.js'),
    db: (await import('../src/db.js')).db,
  };
  ensureAdmin();
  mods.settings.setSetting('reply_delay_seconds', 0);
  mods.inbox.registerSender('whatsapp', async (conv, text) => {
    sent.push({ to: conv.external_id, text });
    return { externalId: `w${sent.length}` };
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-pass' }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.close();
  mock?.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};

test('app: needs sign-in', async () => {
  const res = await fetch(`${base}/app/owners`);
  assert.equal(res.status, 401);
});

test('app: asks to turn the assistant on first', async () => {
  const r = await call('POST', '/app/say', { text: 'hello' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Assistant/);
});

test('app: the owner chats with the assistant in their own assistant conversation', async () => {
  mods.settings.setSetting('assistant', mods.assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Hisham', phone: '+963944111222' }] }));
  const owners = await call('GET', '/app/owners');
  assert.equal(owners.body.enabled, true);
  assert.deepEqual(owners.body.owners, [{ name: 'Hisham', phone: '+963944111222' }]);

  const start = await call('GET', '/app/feed');
  assert.ok(start.body.last >= 0);

  assistantAnswers.push({ action: 'chat', reply: 'Hi Hisham! How can I help?' });
  const said = await call('POST', '/app/say', { text: 'hi' });
  assert.equal(said.status, 200);
  const chat = await until(async () => {
    const r = await call('GET', '/app/chat');
    return r.body.messages.some((m) => m.direction === 'out') && r;
  });
  const [first, reply] = chat.body.messages;
  assert.equal(first.text, 'hi');
  assert.equal(first.direction, 'in');
  assert.equal(reply.text, 'Hi Hisham! How can I help?');
  // Same chat as the owner's WhatsApp messages to the bot (so drafts, yes/no and alerts work), and the
  // reply also reaches their WhatsApp.
  const conv = mods.db.prepare('SELECT * FROM conversations WHERE id = ?').get(chat.body.conversationId);
  assert.equal(conv.external_id, '963944111222@s.whatsapp.net');
  assert.ok(sent.some((s) => s.to === '963944111222@s.whatsapp.net' && /How can I help/.test(s.text)));

  // Only new messages after an id, and the feed brings the assistant's reply for a notification.
  const later = await call('GET', `/app/chat?after=${reply.id}`);
  assert.equal(later.body.messages.length, 0);
  const feed = await call('GET', `/app/feed?after=${start.body.last}`);
  assert.ok(feed.body.messages.some((m) => /How can I help/.test(m.text)));
  assert.ok(feed.body.last >= reply.id);
});

test('app: a missed call is noted, and messaged only when that is turned on (once per cooldown)', async () => {
  const off = await call('POST', '/app/missed-call', { number: '+971 50 123 4567', name: 'Sami' });
  assert.equal(off.status, 200);
  assert.equal(off.body.sent, false);
  const notes = mods.db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'note'").all(off.body.conversationId);
  assert.match(notes[0].text, /Missed call from \+971501234567 \(Sami\)/);

  mods.settings.setSetting('app', { ...mods.settings.getSetting('app'), missed_call_reply: true });
  const before = sent.length;
  const on = await call('POST', '/app/missed-call', { number: '+971501234567' });
  assert.equal(on.body.sent, true);
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to, '971501234567@s.whatsapp.net');
  assert.match(sent.at(-1).text, /اتصالك/); // +971: Arabic

  const again = await call('POST', '/app/missed-call', { number: '+971501234567' });
  assert.equal(again.body.sent, false);
  assert.equal(again.body.skipped, 'cooldown');
  assert.equal(sent.length, before + 1);

  // Local numbers without a country code, and the owner's own number, are not messaged.
  assert.equal((await call('POST', '/app/missed-call', { number: '0501234567' })).status, 400);
  assert.equal((await call('POST', '/app/missed-call', { number: '+963944111222' })).body.skipped, 'owner');
  mods.settings.setSetting('app', { ...mods.settings.getSetting('app'), missed_call_reply: false });
});

test('app: a call note is kept with that customer', async () => {
  const r = await call('POST', '/app/call-note', { number: '+971501234567', text: 'Wants a screen repair quote for iPhone 15' });
  assert.equal(r.status, 200);
  const note = mods.db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'note' ORDER BY id DESC LIMIT 1").get(r.body.conversationId);
  assert.equal(note.text, '📞 Call note: Wants a screen repair quote for iPhone 15');
});

test('app: approvals list what waits for the owner; approve with an edit, or reject', async () => {
  mods.settings.setSetting('assistant', mods.assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', confirm_before_sending: true, owners: [{ name: 'Hisham', phone: '+963944111222' }] }));
  // A message waiting for "yes".
  assistantAnswers.push({ action: 'send_message', to: '+963955000111', text: 'see you at 5' });
  await call('POST', '/app/say', { text: 'send +963955000111 "see you at 5"' });
  const list = await until(async () => {
    const r = await call('GET', '/app/approvals');
    return r.body.count > 0 && r;
  });
  const item = list.body.items.find((i) => i.type === 'confirm');
  assert.equal(item.kind, 'message');
  assert.equal(item.editable, true);
  assert.match(item.text, /see you at 5/);
  // Approved with the owner's own words: those are sent, and the chat says so.
  const before = sent.length;
  const ok = await call('POST', `/app/approvals/${item.id}`, { approve: true, text: 'see you at 6 instead' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(sent.slice(before).some((s) => s.to === '963955000111@s.whatsapp.net' && s.text === 'see you at 6 instead'));
  assert.ok(sent.slice(before).some((s) => s.to === '963944111222@s.whatsapp.net' && /Sent to/.test(s.text)));
  // Gone from the list; deciding again says it was handled.
  assert.equal((await call('GET', '/app/approvals')).body.items.some((i) => i.id === item.id), false);
  assert.equal((await call('POST', `/app/approvals/${item.id}`, { approve: true })).status, 409);

  // Rejected: nothing goes out.
  assistantAnswers.push({ action: 'send_message', to: '+963955000111', text: 'bye' });
  await call('POST', '/app/say', { text: 'send +963955000111 "bye"' });
  const second = await until(async () => (await call('GET', '/app/approvals')).body.items.find((i) => i.type === 'confirm'));
  const n = sent.length;
  await call('POST', `/app/approvals/${second.id}`, { approve: false });
  assert.ok(!sent.slice(n).some((s) => s.to === '963955000111@s.whatsapp.net'));
  assert.ok(sent.slice(n).some((s) => /Cancelled from the app/.test(s.text)));
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});

test('app: an owner WhatsApp knows by a private id (@lid) keeps one chat with the app', async () => {
  mods.settings.setSetting('assistant', mods.assistant.normalizeAssistant({ enabled: true, timezone: 'Asia/Damascus', owners: [{ name: 'Hisham', phone: '+963944111222' }] }));
  const lid = mods.inbox.ensureConversation({ channel: 'whatsapp', externalId: '555000111222333@lid', name: 'Hisham', handle: '+963944111222', meta: { phone: '+963944111222' } });
  const r = await call('GET', '/app/chat');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.conversationId, lid);
  // What the owner says in the app lands in that same chat.
  await call('POST', '/app/say', { text: 'hi again' });
  const last = mods.db.prepare("SELECT conversation_id FROM messages WHERE direction = 'in' ORDER BY id DESC LIMIT 1").get();
  assert.equal(last.conversation_id, lid);
  mods.settings.setSetting('assistant', { ...mods.settings.getSetting('assistant'), enabled: false });
});
