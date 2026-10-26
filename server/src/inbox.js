import { db } from './db.js';
import { emit } from './realtime.js';
import { getSetting } from './settings.js';
import { generateReply } from './ai/agent.js';

const senders = new Map(); // channel -> async (conversation, text) => { externalId? }

export function registerSender(channel, fn) {
  senders.set(channel, fn);
}

function conversationRow(id) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (c) c.meta = JSON.parse(c.meta || '{}');
  return c;
}

export function getConversation(id) {
  return conversationRow(id);
}

function upsertConversation({ channel, accountId = '', externalId, name, handle, subject, meta }) {
  db.prepare(
    `INSERT INTO conversations (channel, account_id, external_id, contact_name, contact_handle, subject, meta)
     VALUES (@channel, @accountId, @externalId, @name, @handle, @subject, @meta)
     ON CONFLICT(channel, account_id, external_id) DO UPDATE SET
       contact_name = COALESCE(excluded.contact_name, contact_name),
       contact_handle = COALESCE(excluded.contact_handle, contact_handle),
       subject = COALESCE(excluded.subject, subject),
       status = 'open'`,
  ).run({ channel, accountId: String(accountId), externalId: String(externalId), name: name || null, handle: handle || null, subject: subject || null, meta: '{}' });
  const conv = db
    .prepare('SELECT id FROM conversations WHERE channel = ? AND account_id = ? AND external_id = ?')
    .get(channel, String(accountId), String(externalId));
  if (meta) updateMeta(conv.id, meta);
  return conv.id;
}

export function updateMeta(id, patch) {
  const c = conversationRow(id);
  db.prepare('UPDATE conversations SET meta = ? WHERE id = ?').run(JSON.stringify({ ...c.meta, ...patch }), id);
}

function insertMessage({ conversationId, direction, sender, text, externalId, meta, error }) {
  const info = db
    .prepare(
      'INSERT INTO messages (conversation_id, direction, sender, text, external_id, meta, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(conversationId, direction, sender, text, externalId || null, JSON.stringify(meta || {}), error || null);
  db.prepare(
    `UPDATE conversations SET last_message = ?, last_message_at = datetime('now'), unread = unread + ? WHERE id = ?`,
  ).run(text.slice(0, 200), direction === 'in' ? 1 : 0, conversationId);
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  emit('message', message);
  emit('conversation', conversationRow(conversationId));
  return message;
}

const pendingReplies = new Map();

// Called by every channel when a customer message arrives.
export function handleIncoming({ channel, accountId, externalId, name, handle, subject, text, messageId, meta, convMeta }) {
  if (!text?.trim()) return;
  if (messageId && db.prepare(
    `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel = ? AND m.external_id = ? AND m.direction = 'in'`).get(channel, String(messageId))) return;

  const conversationId = upsertConversation({ channel, accountId, externalId, name, handle, subject, meta: convMeta });
  insertMessage({ conversationId, direction: 'in', sender: 'customer', text: text.trim(), externalId: messageId, meta });
  scheduleAutoReply(conversationId);
}

// Wait a few seconds so several quick messages get a single combined answer.
function scheduleAutoReply(conversationId) {
  const conv = conversationRow(conversationId);
  if (!getSetting('auto_reply') || !conv.auto_reply) return;
  clearTimeout(pendingReplies.get(conversationId));
  const delay = Math.max(0, Number(getSetting('reply_delay_seconds')) || 0) * 1000;
  pendingReplies.set(
    conversationId,
    setTimeout(() => {
      pendingReplies.delete(conversationId);
      autoReply(conversationId).catch((err) => console.error('[inbox] Auto-reply failed:', err));
    }, delay),
  );
}

async function autoReply(conversationId, { force = false } = {}) {
  emit('typing', { conversationId, typing: true });
  try {
    const { reply, sources } = await generateReply(conversationId);
    // A human may have taken over while the model was thinking.
    if (!force && !conversationRow(conversationId).auto_reply) return;
    await sendMessage(conversationId, reply, { sender: 'ai', meta: { sources: sources.map((s) => ({ title: s.title, score: s.score })) } });
  } finally {
    emit('typing', { conversationId, typing: false });
  }
}

export async function sendMessage(conversationId, text, { sender = 'agent', meta } = {}) {
  const conv = conversationRow(conversationId);
  if (!conv) throw new Error('Conversation not found');
  const send = senders.get(conv.channel);
  let externalId = null;
  let error = null;
  try {
    if (!send) throw new Error(`Channel "${conv.channel}" is not connected`);
    externalId = (await send(conv, text))?.externalId || null;
  } catch (err) {
    error = err.message;
    console.error(`[inbox] Sending on ${conv.channel} failed:`, err.message);
  }
  return insertMessage({ conversationId, direction: 'out', sender, text, externalId, meta, error });
}

export function listConversations({ channel, q, status } = {}) {
  const where = [];
  const params = {};
  if (channel) { where.push('channel = @channel'); params.channel = channel; }
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) { where.push('(contact_name LIKE @q OR contact_handle LIKE @q OR last_message LIKE @q OR subject LIKE @q)'); params.q = `%${q}%`; }
  return db
    .prepare(`SELECT * FROM conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_message_at DESC LIMIT 500`)
    .all(params)
    .map((c) => ({ ...c, meta: JSON.parse(c.meta || '{}') }));
}

export function listMessages(conversationId) {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId);
}

export function updateConversation(id, { auto_reply, status, unread }) {
  if (auto_reply !== undefined) {
    db.prepare('UPDATE conversations SET auto_reply = ? WHERE id = ?').run(auto_reply ? 1 : 0, id);
    if (!auto_reply) clearTimeout(pendingReplies.get(id));
  }
  if (status !== undefined) db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, id);
  if (unread !== undefined) db.prepare('UPDATE conversations SET unread = ? WHERE id = ?').run(unread, id);
  const c = conversationRow(id);
  emit('conversation', c);
  return c;
}

// Let the AI answer now, even when auto-reply is off for this conversation.
export function replyNow(conversationId) {
  return autoReply(conversationId, { force: true });
}
