import express from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { login, changePassword, requireAuth, setSessionCookie, clearSessionCookie } from '../auth.js';
import { getAllSettings, setSetting, getSetting, SETTING_KEYS } from '../settings.js';
import { listConversations, listMessages, sendMessage, updateConversation, getConversation, replyNow } from '../inbox.js';
import { createSource, indexSource, reindexAll, search, invalidateCache } from '../kb/index.js';
import { extractFile, extractUrl } from '../kb/extract.js';
import { answer } from '../ai/agent.js';
import * as ollama from '../ai/ollama.js';
import { channelStatus, restart } from '../channels/index.js';
import { emit } from '../realtime.js';
import { logoutWhatsApp } from '../channels/whatsapp.js';
import { listAccounts, testAccount, PRESETS } from '../channels/email.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const api = express.Router();

// --- Auth ---
api.post('/login', (req, res) => {
  const token = login(req.body?.username, req.body?.password);
  if (!token) return res.status(401).json({ error: 'Wrong username or password' });
  setSessionCookie(res, token);
  res.json({ ok: true });
});
api.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

api.use(requireAuth);

api.get('/me', (req, res) => res.json({ username: req.user.sub }));
api.post('/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (!changePassword(current, next)) return res.status(400).json({ error: 'Current password is wrong' });
  res.json({ ok: true });
});

// --- Inbox ---
api.get('/conversations', (req, res) => res.json(listConversations(req.query)));
api.get('/conversations/:id', (req, res) => {
  const c = getConversation(Number(req.params.id));
  if (!c) return res.sendStatus(404);
  res.json({ conversation: c, messages: listMessages(c.id) });
});
api.patch('/conversations/:id', (req, res) => res.json(updateConversation(Number(req.params.id), req.body || {})));
api.post('/conversations/:id/messages', wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message is empty' });
  res.json(await sendMessage(Number(req.params.id), text, { sender: 'agent' }));
}));
api.post('/conversations/:id/ai-reply', wrap(async (req, res) => {
  await replyNow(Number(req.params.id));
  res.json({ ok: true });
}));
api.delete('/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
api.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    conversations: db.prepare('SELECT channel, COUNT(*) AS n FROM conversations GROUP BY channel').all(),
    open: one("SELECT COUNT(*) AS n FROM conversations WHERE status = 'open'"),
    unread: one('SELECT COALESCE(SUM(unread), 0) AS n FROM conversations'),
    today: db.prepare("SELECT sender, COUNT(*) AS n FROM messages WHERE created_at >= date('now') GROUP BY sender").all(),
    failedToday: one("SELECT COUNT(*) AS n FROM messages WHERE error IS NOT NULL AND created_at >= date('now')"),
    knowledge: one("SELECT COUNT(*) AS n FROM kb_sources WHERE status = 'ready'"),
    redirects: one('SELECT COUNT(*) AS n FROM redirects WHERE enabled = 1'),
  });
});

// --- Knowledge base ---
api.get('/kb', (req, res) => {
  res.json(db.prepare('SELECT id, type, title, origin, status, error, chunk_count, created_at, length(content) AS size FROM kb_sources ORDER BY id DESC').all());
});
api.get('/kb/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM kb_sources WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.sendStatus(404);
  res.json(s);
});
api.post('/kb/text', (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });
  const id = createSource({ type: 'text', title, content });
  indexSource(id);
  res.json({ id });
});
api.put('/kb/:id', (req, res) => {
  const { title, content } = req.body || {};
  db.prepare('UPDATE kb_sources SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?').run(title ?? null, content ?? null, Number(req.params.id));
  indexSource(Number(req.params.id));
  res.json({ ok: true });
});
api.post('/kb/url', wrap(async (req, res) => {
  const urls = String(req.body?.url || '').split(/\s+/).filter(Boolean);
  if (!urls.length) return res.status(400).json({ error: 'URL is required' });
  const results = [];
  for (const url of urls) {
    try {
      new URL(url);
      const { title, text } = await extractUrl(url);
      const id = createSource({ type: 'url', title: title || url, origin: url, content: text });
      indexSource(id);
      results.push({ url, id });
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }
  res.json(results);
}));
api.post('/kb/:id/refresh', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM kb_sources WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.sendStatus(404);
  if (s.type === 'url') {
    const { title, text } = await extractUrl(s.origin);
    db.prepare('UPDATE kb_sources SET title = ?, content = ? WHERE id = ?').run(title || s.origin, text, s.id);
  }
  indexSource(s.id);
  res.json({ ok: true });
}));
api.post('/kb/files', upload.array('files', 20), wrap(async (req, res) => {
  const results = [];
  for (const file of req.files || []) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    try {
      const text = await extractFile(file.buffer, name);
      const id = createSource({ type: 'file', title: name, origin: name, content: text });
      indexSource(id);
      results.push({ name, id });
    } catch (err) {
      results.push({ name, error: err.message });
    }
  }
  res.json(results);
}));
api.delete('/kb/:id', (req, res) => {
  db.prepare('DELETE FROM kb_sources WHERE id = ?').run(Number(req.params.id));
  invalidateCache();
  res.json({ ok: true });
});
api.post('/kb-reindex', (req, res) => {
  reindexAll();
  res.json({ ok: true });
});
api.post('/kb-test', wrap(async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Question is required' });
  res.json(await answer([{ role: 'user', content: question }]));
}));
api.post('/kb-search', wrap(async (req, res) => res.json(await search(String(req.body?.query || ''), { k: 8, minScore: 0 }))));

// --- Redirect rules ---
api.get('/redirects', (req, res) => res.json(db.prepare('SELECT * FROM redirects ORDER BY id').all()));
api.post('/redirects', (req, res) => {
  const { name, when_text, value, enabled = true } = req.body || {};
  if (!name || !when_text || !value) return res.status(400).json({ error: 'Name, when and value are required' });
  const info = db.prepare('INSERT INTO redirects (name, when_text, value, enabled) VALUES (?, ?, ?, ?)').run(name, when_text, value, enabled ? 1 : 0);
  res.json({ id: info.lastInsertRowid });
});
api.put('/redirects/:id', (req, res) => {
  const { name, when_text, value, enabled } = req.body || {};
  db.prepare('UPDATE redirects SET name = ?, when_text = ?, value = ?, enabled = ? WHERE id = ?').run(name, when_text, value, enabled ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});
api.delete('/redirects/:id', (req, res) => {
  db.prepare('DELETE FROM redirects WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// --- Settings ---
const SECRET_FIELDS = { telegram: ['token'], meta: ['app_secret', 'page_token'] };
const MASK = '********';

function maskedSettings() {
  const s = getAllSettings();
  for (const [key, fields] of Object.entries(SECRET_FIELDS)) {
    for (const f of fields) if (s[key][f]) s[key][f] = MASK;
  }
  return s;
}

api.get('/settings', (req, res) => res.json(maskedSettings()));
api.put('/settings', wrap(async (req, res) => {
  const body = req.body || {};
  const before = getAllSettings();
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    let value = body[key];
    if (SECRET_FIELDS[key]) {
      value = { ...before[key], ...value };
      for (const f of SECRET_FIELDS[key]) if (value[f] === MASK) value[f] = before[key][f];
    }
    setSetting(key, value);
  }
  if ('telegram' in body) restart.telegram();
  if ('whatsapp' in body && body.whatsapp.enabled !== before.whatsapp.enabled) restart.whatsapp();
  if (body.embed_model && body.embed_model !== before.embed_model) reindexAll();
  emit('channels', channelStatus());
  res.json(maskedSettings());
}));

// --- AI engine ---
api.get('/ai/status', wrap(async (req, res) => res.json(await ollama.status())));
api.post('/ai/pull', (req, res) => {
  const model = req.body?.model;
  if (!model) return res.status(400).json({ error: 'Model is required' });
  ollama.pullModel(model);
  res.json({ ok: true });
});
api.post('/ai/cancel', (req, res) => {
  ollama.cancelPull(req.body?.model);
  res.json({ ok: true });
});
api.delete('/ai/models/:model', wrap(async (req, res) => {
  const model = req.params.model;
  const inUse = [getSetting('chat_model'), getSetting('embed_model')];
  if (inUse.includes(model)) return res.status(400).json({ error: 'This model is in use. Choose another model in Settings first.' });
  await ollama.deleteModel(model);
  res.json({ ok: true });
}));

// --- Channels ---
api.get('/channels', (req, res) => res.json(channelStatus()));
api.post('/channels/whatsapp/restart', (req, res) => {
  restart.whatsapp();
  res.json({ ok: true });
});
api.post('/channels/whatsapp/logout', wrap(async (req, res) => {
  await logoutWhatsApp();
  res.json({ ok: true });
}));
api.post('/channels/telegram/restart', (req, res) => {
  restart.telegram();
  res.json({ ok: true });
});

api.get('/email-presets', (req, res) => res.json(PRESETS));
api.get('/email-accounts', (req, res) => res.json(listAccounts()));

const EMAIL_FIELDS = ['name', 'email', 'imap_host', 'imap_port', 'imap_secure', 'smtp_host', 'smtp_port', 'smtp_secure', 'username', 'password', 'enabled'];
function emailInput(body, existing = {}) {
  const a = { ...existing };
  for (const f of EMAIL_FIELDS) if (body[f] !== undefined && !(f === 'password' && body[f] === MASK)) a[f] = body[f];
  for (const f of ['imap_secure', 'smtp_secure', 'enabled']) a[f] = a[f] ? 1 : 0;
  for (const f of ['imap_port', 'smtp_port']) a[f] = Number(a[f]);
  a.username ||= a.email;
  a.name ||= a.email;
  return a;
}

api.post('/email-accounts/test', wrap(async (req, res) => {
  const existing = req.body.id ? db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(req.body.id) : {};
  try {
    await testAccount(emailInput(req.body, existing));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.responseText || err.message });
  }
}));
api.post('/email-accounts', (req, res) => {
  const a = emailInput({ imap_port: 993, imap_secure: 1, smtp_port: 465, smtp_secure: 1, enabled: 1, ...req.body });
  if (!a.email || !a.imap_host || !a.smtp_host || !a.password) return res.status(400).json({ error: 'Email, servers and password are required' });
  const info = db.prepare(
    `INSERT INTO email_accounts (name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password, enabled)
     VALUES (@name, @email, @imap_host, @imap_port, @imap_secure, @smtp_host, @smtp_port, @smtp_secure, @username, @password, @enabled)`,
  ).run(a);
  restart.email();
  res.json({ id: info.lastInsertRowid });
});
api.put('/email-accounts/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.sendStatus(404);
  const a = emailInput(req.body, existing);
  db.prepare(
    `UPDATE email_accounts SET name=@name, email=@email, imap_host=@imap_host, imap_port=@imap_port, imap_secure=@imap_secure,
     smtp_host=@smtp_host, smtp_port=@smtp_port, smtp_secure=@smtp_secure, username=@username, password=@password, enabled=@enabled WHERE id=@id`,
  ).run({ ...a, id: existing.id });
  restart.email();
  res.json({ ok: true });
});
api.delete('/email-accounts/:id', (req, res) => {
  db.prepare('DELETE FROM email_accounts WHERE id = ?').run(Number(req.params.id));
  restart.email();
  res.json({ ok: true });
});

api.use((err, req, res, next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});
