import express from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { getSetting, setSetting } from '../settings.js';
import { handleIncoming, ensureConversation, sendMessage, addNote, listMessages } from '../inbox.js';
import { handleVoiceNote, handleImage } from '../voice.js';
import { assistantSettings, listApprovals, decideApproval } from '../assistant/index.js';

// The Android companion app. It signs in like the dashboard (same cookie) and works as a window onto
// the owner's own assistant chat: what the owner types, says or photographs in the app goes into the
// same conversation as their WhatsApp messages to the assistant, so drafts, yes/no, alerts and
// questions all work the same way. The phone also reports missed calls and call notes.

export const device = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const samePhone = (a, b) => {
  const x = digitsOf(a);
  const y = digitsOf(b);
  return x.length >= 7 && y.length >= 7 && (x === y || x.endsWith(y.slice(-9)) || y.endsWith(x.slice(-9)));
};

function owners() {
  const s = assistantSettings();
  return (s.owners || []).filter((o) => o.enabled !== false && digitsOf(o.phone).length >= 7);
}

// The owner the app speaks for: the phone chosen in the app, else the first owner with a phone.
function ownerFor(req) {
  const wanted = req.body?.owner || req.query.owner;
  const list = owners();
  return (wanted ? list.find((o) => samePhone(o.phone, wanted)) : list[0]) || null;
}

// The owner's assistant chat: the same WhatsApp conversation their own messages to the bot arrive in.
// WhatsApp may know them by a private id (…@lid) instead of their number, so an existing chat with
// their phone is used first; only without one is a chat keyed by the number made.
function ownerIdentity(owner) {
  const digits = digitsOf(owner.phone);
  // WhatsApp's own id for them (…@lid), where their real WhatsApp messages arrive, wins.
  const existing = db
    .prepare("SELECT external_id, meta FROM conversations WHERE channel = 'whatsapp' AND external_id NOT LIKE '%@g.us' AND external_id NOT LIKE '%@s.whatsapp.net' ORDER BY id")
    .all()
    .find((c) => samePhone(JSON.parse(c.meta || '{}').phone, digits));
  const externalId = existing?.external_id || `${digits}@s.whatsapp.net`;
  return { channel: 'whatsapp', externalId, handle: `+${digits}`, name: owner.name || null, convMeta: { phone: `+${digits}` } };
}

function ownerConversation(owner) {
  const id = ownerIdentity(owner);
  return ensureConversation({ channel: id.channel, externalId: id.externalId, name: id.name, handle: id.handle, meta: id.convMeta });
}

const messageId = () => `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function needOwner(req, res) {
  if (!assistantSettings().enabled) {
    res.status(409).json({ error: 'Turn on the Assistant in the dashboard (Assistant page) and add your number as an owner.' });
    return null;
  }
  const owner = ownerFor(req);
  if (!owner) res.status(409).json({ error: 'No owner with a phone number. Add yours on the Assistant page in the dashboard.' });
  return owner;
}

// Who the app can speak as, and their chat with the assistant.
device.get('/owners', (req, res) => {
  res.json({
    enabled: !!assistantSettings().enabled,
    company: getSetting('company_name'),
    owners: owners().map((o) => ({ name: o.name || '', phone: o.phone })),
  });
});

device.get('/chat', (req, res) => {
  const owner = needOwner(req, res);
  if (!owner) return;
  const conversationId = ownerConversation(owner);
  const after = Number(req.query.after) || 0;
  const messages = listMessages(conversationId).filter((m) => m.id > after && m.direction !== 'note');
  res.json({ owner: { name: owner.name || '', phone: owner.phone }, conversationId, messages });
});

device.post('/say', (req, res) => {
  const owner = needOwner(req, res);
  if (!owner) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write something first' });
  const conversationId = handleIncoming({ ...ownerIdentity(owner), text, messageId: messageId(), meta: { via: 'app' }, autoReply: false });
  res.json({ ok: true, conversationId });
});

device.post('/voice', upload.single('audio'), wrap(async (req, res) => {
  const owner = needOwner(req, res);
  if (!owner) return;
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No recording' });
  const ext = (req.file.originalname.split('.').pop() || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '') || 'm4a';
  // Transcribing takes a few seconds: answer now, the reply shows up in the chat.
  res.json({ ok: true, conversationId: ownerConversation(owner) });
  handleVoiceNote({ ...ownerIdentity(owner), buffer: req.file.buffer, ext, duration: Number(req.body?.duration) || null, messageId: messageId(), autoReply: false })
    .catch((err) => console.error('[app] Voice note failed:', err.message));
}));

device.post('/photo', upload.single('image'), wrap(async (req, res) => {
  const owner = needOwner(req, res);
  if (!owner) return;
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No photo' });
  res.json({ ok: true, conversationId: ownerConversation(owner) });
  handleImage({ ...ownerIdentity(owner), buffer: req.file.buffer, caption: String(req.body?.caption || ''), messageId: messageId(), autoReply: false })
    .catch((err) => console.error('[app] Photo failed:', err.message));
}));

// --- Calls on the business phone ---

// Auto answer: the phone keeps its own copy (works offline) and both sides follow whichever changed
// it last (by time).
function phoneSettings() {
  const s = getSetting('app');
  return { auto_answer: !!s.auto_answer, rings: Math.min(10, Math.max(1, Number(s.auto_answer_rings) || 3)), at: Number(s.auto_answer_at) || 0 };
}

device.get('/phone', (req, res) => res.json(phoneSettings()));

device.post('/phone', (req, res) => {
  const now = phoneSettings();
  const at = Number(req.body?.at) || Date.now();
  if (at > now.at) {
    const s = getSetting('app');
    setSetting('app', {
      ...s,
      auto_answer: req.body?.auto_answer === undefined ? s.auto_answer : !!req.body.auto_answer,
      auto_answer_rings: req.body?.rings === undefined ? s.auto_answer_rings : Math.min(10, Math.max(1, Number(req.body.rings) || 3)),
      auto_answer_at: at,
    });
  }
  res.json(phoneSettings());
});

function callerConversation(number, name) {
  const digits = digitsOf(number);
  return ensureConversation({ channel: 'whatsapp', externalId: `${digits}@s.whatsapp.net`, name: name || null, handle: `+${digits}`, meta: { phone: `+${digits}` } });
}

function validCaller(number) {
  const digits = digitsOf(number);
  // Needs the country code: a local 0… number can't be turned into a WhatsApp chat reliably.
  return digits.length >= 8 && !String(number).trim().startsWith('0') ? digits : null;
}

const recentlyMessaged = new Map(); // digits -> time, so repeated missed calls don't send repeated messages

// A call nobody answered: optionally message the caller on WhatsApp straight away, and tell the owner.
device.post('/missed-call', wrap(async (req, res) => {
  const s = getSetting('app');
  const digits = validCaller(req.body?.number);
  if (!digits) return res.status(400).json({ error: 'Send the number with its country code' });
  if (owners().some((o) => samePhone(o.phone, digits))) return res.json({ ok: true, skipped: 'owner' });
  const conversationId = callerConversation(digits, req.body?.name);
  addNote(conversationId, `📞 Missed call from +${digits}${req.body?.name ? ` (${req.body.name})` : ''}.`);
  if (!s.missed_call_reply) return res.json({ ok: true, conversationId, sent: false });
  const last = recentlyMessaged.get(digits) || 0;
  if (Date.now() - last < (Number(s.missed_call_cooldown_hours) || 12) * 3600e3) return res.json({ ok: true, conversationId, sent: false, skipped: 'cooldown' });
  recentlyMessaged.set(digits, Date.now());
  const arabic = /^(963|971|966|962|961|964|965|968|973|974|20|212|213|216|218|249)/.test(digits);
  const text = String((arabic ? s.missed_call_ar : s.missed_call_en) || s.missed_call_en || '').replace('{company}', getSetting('company_name')).trim();
  const msg = await sendMessage(conversationId, text, { sender: 'ai', meta: { missedCall: true } });
  res.json({ ok: !msg.error, conversationId, sent: !msg.error, error: msg.error || null });
}));

// A short note after a call ("what was it about?"), kept with that customer's chat for the team and the AI.
device.post('/call-note', (req, res) => {
  const digits = validCaller(req.body?.number);
  const text = String(req.body?.text || '').trim();
  if (!digits || !text) return res.status(400).json({ error: 'Number (with country code) and note are needed' });
  const conversationId = callerConversation(digits, req.body?.name);
  addNote(conversationId, `📞 Call note: ${text}`, { callNote: true });
  res.json({ ok: true, conversationId });
});

// --- Approvals: everything waiting for the owner's OK, decided with a tap (and an edit if needed) ---
device.get('/approvals', (req, res) => {
  const items = listApprovals();
  res.json({ items, count: items.length });
});

device.post('/approvals/:id', wrap(async (req, res) => {
  const approve = req.body?.approve === true || req.body?.decision === 'approve';
  const r = await decideApproval(String(req.params.id), { approve, text: req.body?.text ?? null });
  if (!r.ok && r.error && !r.status) return res.status(409).json(r);
  res.json(r);
}));

// Things the owner should see as phone notifications: assistant messages to any owner after an id.
// The first call (no "after") only returns where to start, so old messages don't pop up.
device.get('/feed', (req, res) => {
  if (req.query.after === undefined || req.query.after === '') {
    return res.json({ messages: [], last: db.prepare('SELECT MAX(id) AS id FROM messages').get().id || 0 });
  }
  const after = Number(req.query.after) || 0;
  const ids = owners().map((o) => db.prepare('SELECT id FROM conversations WHERE channel = ? AND external_id = ?').get('whatsapp', ownerIdentity(o).externalId)?.id).filter(Boolean);
  const rows = ids.length
    ? db.prepare(`SELECT id, conversation_id, text, meta, created_at FROM messages
        WHERE direction = 'out' AND id > ? AND conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY id LIMIT 50`).all(after, ...ids)
    : [];
  res.json({ messages: rows.map((m) => ({ ...m, meta: JSON.parse(m.meta || '{}') })), last: Math.max(after, ...rows.map((r) => r.id)), approvals: listApprovals().length });
});
