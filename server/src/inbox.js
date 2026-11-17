import { db } from './db.js';
import { emit } from './realtime.js';
import { getSetting } from './settings.js';
import { generateReply } from './ai/agent.js';
import { afterReply } from './handoff.js';
import { isOwnerConversation, handleOwnerMessage, askOwnerAbout, alertOwnerIfUrgent, holdForDraft } from './assistant/index.js';
import { speak, saveVoiceNote } from './ai/tts.js';
import { productPhotosFor } from './catalog.js';
import { MEDIA_DIR } from './voice.js';
import fs from 'node:fs';
import path from 'node:path';

const senders = new Map(); // channel -> async (conversation, text) => { externalId? }
const voiceSenders = new Map(); // channel -> async (conversation, oggBuffer) => { externalId? }

export function registerSender(channel, fn) {
  senders.set(channel, fn);
}
export function registerVoiceSender(channel, fn) {
  voiceSenders.set(channel, fn);
}
// "typing…" / "recording audio…" in the customer's app while the AI works on an answer.
const presenceSenders = new Map(); // channel -> { fn: async (externalId, 'typing' | 'recording' | 'paused'), every }
export function registerPresence(channel, fn, every = 4000) {
  presenceSenders.set(channel, { fn, every });
}
// Starts showing the state and keeps it up until the returned stop() is called (max 3 minutes).
export function showPresenceTo(channel, externalId, kind = 'typing') {
  const p = presenceSenders.get(channel);
  if (!p || !externalId || getSetting('presence')?.enabled === false) return () => {};
  let on = true;
  const tick = () => on && p.fn(externalId, kind).catch(() => {});
  tick();
  const timer = setInterval(tick, p.every);
  const limit = setTimeout(() => stop(), 180e3);
  function stop() {
    if (!on) return;
    on = false;
    clearInterval(timer);
    clearTimeout(limit);
    p.fn(externalId, 'paused').catch(() => {});
  }
  return stop;
}
// While a voice note or photo is being read, before the message is in the inbox: only when the AI
// will answer this chat.
export function showPresenceForIncoming({ channel, accountId = '', externalId, autoReply = true }, kind = 'typing') {
  if (autoReply === false) return () => {};
  const c = db.prepare('SELECT auto_reply FROM conversations WHERE channel = ? AND account_id = ? AND external_id = ?').get(channel, accountId || '', externalId);
  if (c && !c.auto_reply) return () => {};
  return showPresenceTo(channel, externalId, kind);
}
export function showPresence(conversationId, kind = 'typing') {
  const conv = conversationRow(conversationId);
  return conv ? showPresenceTo(conv.channel, conv.external_id, kind) : () => {};
}

const imageSenders = new Map(); // channel -> async (conversation, jpegBuffer, caption) => { externalId? }
export function registerImageSender(channel, fn) {
  imageSenders.set(channel, fn);
}

// Send a saved photo (data/media) with a short caption.
export async function sendImage(conversationId, file, caption = '', { sender = 'ai', meta } = {}) {
  const conv = conversationRow(conversationId);
  if (!conv) throw new Error('Conversation not found');
  let externalId = null;
  let error = null;
  try {
    if (!imageSenders.has(conv.channel)) throw new Error(`Photos can't be sent on ${conv.channel}`);
    externalId = (await imageSenders.get(conv.channel)(conv, fs.readFileSync(path.join(MEDIA_DIR, file)), caption))?.externalId || null;
  } catch (err) {
    error = err.message;
    console.error(`[inbox] Sending a photo on ${conv.channel} failed:`, err.message);
  }
  return insertMessage({ conversationId, direction: 'out', sender, text: caption || '📷 Photo', externalId, meta: { ...meta, image: file, caption: caption || null, sent: true }, error });
}

// The reply was about products with photos: send them too.
export async function sendProductPhotos(conversationId, reply, sourceIds) {
  const conv = conversationRow(conversationId);
  if (!conv || !imageSenders.has(conv.channel)) return;
  for (const p of productPhotosFor(conversationId, reply, sourceIds)) {
    await sendImage(conversationId, p.image, [p.name, p.price].filter(Boolean).join(' · '), { meta: { product: p.id } });
  }
}

// Should this reply be spoken? audience: 'owner' or 'customer'. "mirror" answers a voice note
// with a voice note.
export function wantsVoice(conversationId, audience) {
  const s = getSetting('speak');
  if (!s.enabled) return false;
  const conv = conversationRow(conversationId);
  if (!conv || !voiceSenders.has(conv.channel)) return false;
  const mode = audience === 'owner' ? s.owners : s.customers;
  if (mode === 'always') return true;
  if (mode !== 'mirror') return false;
  const last = db.prepare("SELECT meta FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(conversationId);
  return !!JSON.parse(last?.meta || '{}').voice;
}

// Links, numbers, emails and long answers are easier to read than to hear: they always go as text too.
const needsText = (text) => /https?:\/\/|@\S+\.|\+?\d[\d\s-]{6,}\d/.test(text) || text.length > 600;

function conversationRow(id) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (c) c.meta = JSON.parse(c.meta || '{}');
  return c;
}

export function getConversation(id) {
  return conversationRow(id);
}

export function ensureConversation(fields) {
  return upsertConversation(fields);
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
// Returns the conversation id, or null when the message was empty or already stored.
export function handleIncoming({ channel, accountId, externalId, name, handle, subject, text, messageId, meta, convMeta, autoReply = true }) {
  if (!text?.trim()) return null;
  if (messageId && db.prepare(
    `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel = ? AND m.external_id = ? AND m.direction = 'in'`).get(channel, String(messageId))) return null;

  const conversationId = upsertConversation({ channel, accountId, externalId, name, handle, subject, meta: convMeta });
  const stored = insertMessage({ conversationId, direction: 'in', sender: 'customer', text: text.trim(), externalId: messageId, meta });
  // Numbers chosen under Assistant give the bot tasks instead of getting customer answers.
  if ((channel === 'whatsapp' || channel === 'telegram') && !meta?.transcribeError && isOwnerConversation(conversationId)) {
    handleOwnerMessage(conversationId, stored.id).catch(() => {});
    return conversationId;
  }
  if (autoReply) {
    // Complaints, refunds, cancellations: tell the owner straight away.
    alertOwnerIfUrgent(conversationId, text.trim()).catch((err) => console.error('[assistant] Alert failed:', err.message));
    scheduleAutoReply(conversationId);
  }
  return conversationId;
}

// A note in the conversation for the team (e.g. "forwarded to …"). Never sent to the customer.
export function addNote(conversationId, text, meta) {
  const info = db
    .prepare("INSERT INTO messages (conversation_id, direction, sender, text, meta) VALUES (?, 'note', 'system', ?, ?)")
    .run(conversationId, text, JSON.stringify(meta || {}));
  emit('message', db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
}

// Wait a few seconds so several quick messages get a single combined answer.
export function scheduleAutoReply(conversationId) {
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
  const stopPresence = showPresence(conversationId, wantsVoice(conversationId, 'customer') ? 'recording' : 'typing');
  try {
    const { reply, sources, tag, unsure } = await generateReply(conversationId);
    // A human may have taken over while the model was thinking.
    if (!force && !conversationRow(conversationId).auto_reply) return;
    // Draft mode: an answer on a topic the owner hasn't approved enough yet waits for them.
    if (!force && !tag && !unsure && await holdForDraft(conversationId, reply, sources)) return;
    await sendMessage(conversationId, reply, { sender: 'ai', voice: wantsVoice(conversationId, 'customer'), meta: { sources: sources.map((s) => ({ title: s.title, score: s.score })), ...(unsure ? { unsure: true } : {}) } });
    if (!tag) await sendProductPhotos(conversationId, reply, sources.map((s) => s.source_id)).catch((err) => console.warn('[catalog] Photo not sent:', err.message));
    afterReply(conversationId, tag).catch((err) => addNote(conversationId, `Team handoff failed: ${err.message}`));
    // The AI didn't know: ask the owner, who can answer by chat (sent to the customer and remembered).
    if (unsure && !tag && !conversationRow(conversationId)?.meta?.group) askOwnerAbout(conversationId).catch((err) => console.error('[assistant] Asking the owner failed:', err.message));
  } finally {
    stopPresence();
    emit('typing', { conversationId, typing: false });
  }
}

export async function sendMessage(conversationId, text, { sender = 'agent', meta, voice = false } = {}) {
  const conv = conversationRow(conversationId);
  if (!conv) throw new Error('Conversation not found');
  const send = senders.get(conv.channel);
  let externalId = null;
  let error = null;
  // A spoken reply: a voice note, plus the text when it's wanted or needed. If speaking fails, text only.
  let spoken = false;
  if (voice && voiceSenders.has(conv.channel)) {
    try {
      const audio = await speak(text);
      externalId = (await voiceSenders.get(conv.channel)(conv, audio))?.externalId || null;
      meta = { ...meta, audio: saveVoiceNote(audio), spoken: true };
      spoken = true;
    } catch (err) {
      console.warn(`[voice] Sending as text instead: ${err.message}`);
    }
  }
  try {
    if (spoken && !getSetting('speak').also_text && !needsText(text)) return insertMessage({ conversationId, direction: 'out', sender, text, externalId, meta });
    if (!send) throw new Error(`Channel "${conv.channel}" is not connected`);
    externalId = (await send(conv, text))?.externalId || externalId;
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
