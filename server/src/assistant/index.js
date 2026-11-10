import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from '../ai/ollama.js';
import { detectLanguage } from '../ai/agent.js';
import { getConversation, sendMessage, updateMeta, ensureConversation } from '../inbox.js';
import { outboundSenders, teamContacts } from '../handoff.js';
import { emit } from '../realtime.js';
import { fromLocal, toLocal, nowContext, pretty, localDayBounds, validTimeZone, dayFromWords } from './time.js';

// The owner assistant: numbers chosen under "Assistant" can message the bot (text or voice) to give
// it tasks: reminders, appointments, messages to clients and emails, now or later. Anything that
// goes to someone else is shown first and only sent after the owner answers "yes".

const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const CONFIRM_MINUTES = 30;

export function assistantSettings() {
  return getSetting('assistant');
}

function timeZone() {
  const tz = assistantSettings().timezone;
  return validTimeZone(tz) ? tz : 'UTC';
}

const samePhone = (a, b) => {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (x.length < 7 || y.length < 7) return false;
  return x === y || (x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9));
};

// The owner this conversation belongs to, or null.
export function ownerOf(conv) {
  const s = assistantSettings();
  if (!s.enabled || !conv) return null;
  const owners = (s.owners || []).filter((o) => o.enabled !== false);
  if (conv.channel === 'whatsapp') {
    const phone = conv.meta?.phone || (conv.external_id.endsWith('@s.whatsapp.net') ? conv.external_id.split('@')[0] : conv.contact_handle);
    return owners.find((o) => samePhone(o.phone, phone)) || null;
  }
  if (conv.channel === 'telegram') {
    const handle = String(conv.contact_handle || '').replace(/^@/, '').toLowerCase();
    const id = String(conv.external_id);
    return owners.find((o) => {
      const t = String(o.telegram || '').trim().replace(/^@/, '').toLowerCase();
      return t && (t === handle || t === id);
    }) || null;
  }
  return null;
}

export function isOwnerConversation(conversationId) {
  return !!ownerOf(getConversation(conversationId));
}

// Keep owner settings tidy when saved from the dashboard.
export function normalizeAssistant(value) {
  const owners = (value?.owners || [])
    .map((o) => ({ name: String(o.name || '').trim(), phone: String(o.phone || '').trim(), telegram: String(o.telegram || '').trim(), enabled: o.enabled !== false }))
    .filter((o) => o.phone || o.telegram);
  const minutes = Number(value?.event_reminder_minutes);
  const briefing = String(value?.daily_briefing || '').trim();
  return {
    enabled: !!value?.enabled,
    timezone: validTimeZone(value?.timezone) ? value.timezone : 'Asia/Damascus',
    confirm_before_sending: value?.confirm_before_sending !== false,
    event_reminder_minutes: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : 30,
    daily_briefing: /^\d{1,2}:\d{2}$/.test(briefing) ? briefing.padStart(5, '0') : '',
    owners,
  };
}

const say = (language, en, ar) => (language === 'Arabic' ? ar : en);
// A question back to the owner. While it is open, "no" cancels instead of starting something new.
const asking = (text) => ({ ask: text });

// --- Tasks ---
function insertTask({ kind, conv, owner, runAt, payload }) {
  const info = db
    .prepare('INSERT INTO tasks (kind, owner_conversation_id, owner_name, run_at, payload) VALUES (?, ?, ?, ?, ?)')
    .run(kind, conv?.id ?? null, owner?.name || null, runAt.toISOString(), JSON.stringify(payload || {}));
  emit('tasks', { changed: true });
  return info.lastInsertRowid;
}

function finishTask(id, status, result) {
  db.prepare("UPDATE tasks SET status = ?, result = ?, done_at = datetime('now') WHERE id = ?").run(status, result || null, id);
  emit('tasks', { changed: true });
}

export function listTasks({ status } = {}) {
  const rows = status === 'pending'
    ? db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY run_at LIMIT 300").all()
    : db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 300').all();
  return rows.map((t) => ({ ...t, payload: JSON.parse(t.payload || '{}') }));
}

export function cancelTask(id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) throw new Error('Task not found');
  if (t.status !== 'pending') throw new Error('Only waiting tasks can be cancelled');
  finishTask(id, 'cancelled', 'Cancelled');
}

const ICON = { reminder: '⏰', event: '📅', message: '💬', email: '✉️', briefing: '☀️' };

function describeTask(t, language) {
  const p = typeof t.payload === 'string' ? JSON.parse(t.payload) : t.payload;
  const tz = timeZone();
  const at = new Date(p.event_at || t.run_at);
  const what = t.kind === 'message' ? say(language, `message to ${p.label}: ${p.text}`, `رسالة إلى ${p.label}: ${p.text}`)
    : t.kind === 'email' ? say(language, `email to ${p.label}: ${p.subject}`, `إيميل إلى ${p.label}: ${p.subject}`)
      : p.text || p.title;
  return `#${t.id} · ${pretty(at, tz, language)} · ${ICON[t.kind] || ''} ${what}`;
}

// --- Understanding the owner's message ---
const ACTIONS = ['reminder', 'schedule', 'send_message', 'send_email', 'list', 'cancel', 'summary', 'help', 'chat'];
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    when: { type: ['string', 'null'] },
    text: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    task_id: { type: ['integer', 'null'] },
    reply: { type: ['string', 'null'] },
  },
  required: ['action'],
};

// The next seven days, so the model doesn't have to work out which date "Thursday" is.
function calendar() {
  const tz = timeZone();
  const today = toLocal(new Date(), tz).slice(0, 10);
  return Array.from({ length: 8 }, (_, n) => {
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3);
    const name = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    return `${name} ${d.toISOString().slice(0, 10)}${n === 0 ? ' (today)' : n === 1 ? ' (tomorrow)' : ''}`;
  }).join(', ');
}

function systemPrompt(owner, language) {
  const tz = timeZone();
  return [
    `You are the personal assistant of ${owner.name || 'the owner'} at ${getSetting('company_name')}. They give you tasks by chat, in Arabic or English.`,
    `Now it is ${nowContext(new Date(), tz)} (${tz}).`,
    'Turn their latest message into ONE JSON object with these fields:',
    '- action, one of:',
    '  reminder: remind the owner about something at a time ("remind me tomorrow at 9 to call Ahmad", "ذكرني بكرا الساعة 9").',
    '  schedule: put an appointment or meeting in their calendar ("I have a meeting with Sami on Thursday at 4").',
    '  send_message: send a WhatsApp message to another person (a client or colleague), now or at a time.',
    '  send_email: send an email to someone, now or at a time.',
    '  list: show their upcoming tasks (for one day: put that day in "when").',
    '  cancel: cancel a task by its number (#).',
    '  summary: what happened today (new chats, requests passed to the team, tasks).',
    '  help: what you can do.',
    '  chat: anything else; answer briefly in "reply".',
    `- when: the local date and time as "YYYY-MM-DD HH:mm", or null for "now" / not given. Use this calendar for day names: ${calendar()}. "بعد ساعتين" means two hours from now. If only a day is given for a reminder, use 09:00.`,
    `- text: for reminder and schedule, what to remember, short, in ${language}, without "remind me" and without the date or time. For send_message and send_email, a first draft of the message written TO the recipient (carry out the owner's instructions, e.g. "tell him how are you" becomes a greeting asking how they are), WITHOUT the delivery time ("tomorrow at 10" is for "when", not for the message).`,
    '- to: for send_message the person\'s name or the phone number exactly as written in the message (digits and +); for send_email the email address or name. Otherwise null.',
    '- subject: the email subject, or null.',
    '- task_id: for cancel, the task number. Otherwise null.',
    `- reply: for help or chat, a short answer in ${language}. Otherwise "".`,
    'Write only Arabic or English, never Chinese. Answer with the JSON object only.',
  ].join('\n');
}

async function understand(conv, owner, language, text) {
  const history = db
    .prepare("SELECT direction, text FROM messages WHERE conversation_id = ? AND direction <> 'note' AND error IS NULL ORDER BY id DESC LIMIT 5")
    .all(conv.id)
    .reverse()
    .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text }));
  const raw = await chat([{ role: 'system', content: systemPrompt(owner, language) }, ...history], { temperature: 0, format: SCHEMA });
  let cmd;
  try {
    cmd = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return { action: 'help' };
  }
  if (!ACTIONS.includes(cmd.action)) cmd.action = 'chat';
  return fixCommand(cmd, text, language);
}

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/;
const REMIND_ME = /^\s*(please\s+)?(remind\s+me\s+(to\s+|about\s+|that\s+)?|ذكر(ني|نى)\s*|تذكر(ني|نى)\s*|فكرني\s*)/i;
const TIME_PHRASE = /[\s,،.]*((يوم\s+)?(بعد\s+)?(بكرا|بكره|بكرة|غدا|غدًا|غداً|اليوم|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)|(on\s+)?(today|tomorrow|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday))?[\s,،]*(الساعة|الساعه|ع\s*الساعة|at)\s*\d{1,2}([:.]\d{2})?\s*(الصبح|الصباح|صباحا|صباحاً|المسا|المساء|مساء|مساءً|العصر|عصرا|الظهر|ظهرا|بالليل|am|pm|a\.m\.|p\.m\.)?[\s.!]*$/i;
const TIME_LEAD = /^\s*(((on\s+)?(today|tomorrow|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|بكرا|بكره|بكرة|غدا|غداً|اليوم)(?=\s|$))?\s*((at|الساعة|الساعه)\s*\d{1,2}([:.]\d{2})?\s*(am|pm|الصبح|الصباح|المسا|المساء|العصر|الظهر)?)?\s*(to\s+|إنو\s+|انو\s+)?/i;
const RELATIVE = /^\s*(بعد\s+(ساعة|ساعه|ساعتين|نص\s+ساعة|ربع\s+ساعة|دقيقة|دقيقتين|\d+\s*(ساعات|ساعة|دقيقة|دقايق|دقائق))|in\s+(an?\s+hour|half\s+an\s+hour|\d+\s*(hours?|minutes?|mins?)))\s*(to\s+)?/i;
const PHONE = /\+?\d[\d\s-]{6,}\d/;

// Small models get some things wrong; check them against what the owner actually wrote.
export function fixCommand(cmd, text, language) {
  const tz = timeZone();
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  cmd.text = clean(cmd.text);
  cmd.to = clean(cmd.to);
  cmd.when = clean(cmd.when);

  // The date of "Thursday" / "بكرا" comes from the words, not from the model's arithmetic.
  const day = dayFromWords(text, new Date(), tz);
  if (cmd.when && day && !(cmd.text || '').toLowerCase().includes(day.word) && /^\d{4}-\d{2}-\d{2}/.test(cmd.when)) {
    cmd.when = day.date + cmd.when.slice(10);
  }
  if (!cmd.when && day && ['reminder', 'schedule', 'list'].includes(cmd.action)) cmd.when = cmd.action === 'list' ? day.date : null;

  if (cmd.action === 'reminder' || cmd.action === 'schedule') {
    // Chinese, or Arabic for an owner who wrote in English: use the owner's own words instead.
    if (cmd.text && (CJK.test(cmd.text) || (language === 'English' && /[\u0600-\u06FF]/.test(cmd.text)))) cmd.text = null;
    if (!cmd.text) cmd.text = text.replace(REMIND_ME, '').replace(TIME_LEAD, '').trim() || null;
    if (cmd.text) cmd.text = cmd.text.replace(REMIND_ME, '').replace(RELATIVE, '').replace(TIME_LEAD, '').replace(TIME_PHRASE, '').trim() || cmd.text;
  }
  if (cmd.action === 'send_message' || cmd.action === 'send_email') {
    if (cmd.text && CJK.test(cmd.text)) cmd.text = null;
    if (cmd.text && cmd.when) cmd.text = cmd.text.replace(TIME_PHRASE, '').trim() || cmd.text;
    // Models sometimes make up a number. Only numbers the owner actually wrote are used.
    const written = digitsOf(text);
    if (cmd.to && digitsOf(cmd.to).length >= 7 && !written.includes(digitsOf(cmd.to).slice(-7))) {
      cmd.to = cmd.to.replace(/\+?\d[\d\s-]{5,}\d/g, '').replace(/[()]/g, '').trim() || null;
    }
    if (cmd.action === 'send_message' && !(cmd.to && digitsOf(cmd.to).length >= 7)) {
      const phone = text.match(PHONE)?.[0];
      if (phone && digitsOf(phone).length >= 7) cmd.to = phone;
    }
    if (cmd.action === 'send_email' && !(cmd.to && cmd.to.includes('@'))) {
      const address = text.match(/[^\s<>"'،,]+@[^\s<>"'،,]+\.[a-z]{2,}/i)?.[0];
      if (address) cmd.to = address;
    }
  }
  if (cmd.reply && CJK.test(cmd.reply)) cmd.reply = null;
  cmd.said = text;
  return cmd;
}

// Remove instruction words and numbers a small model copied into the message.
function cleanDraft(text, target) {
  let out = text;
  const digits = digitsOf(target.phone || target.label || '');
  if (digits.length >= 7) out = out.replace(/\s*(لـ|ل|to)?\s*\+?\d[\d\s-]{5,}\d/g, (m) => (digitsOf(m).slice(-7) === digits.slice(-7) ? '' : m));
  out = out.replace(/(^|[\s،,.])(قل(و|ه|ها|لو|ي)|احكي مع|ابعت(ل|لـ)?|tell (him|her|them))(?=[\s،,.]|$)\s*(لـ|ل)?\s*(إنو|انو|إنه|أنه|أن|that)?/gi, '$1');
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([،,.!؟?])/g, '$1').trim();
}

// The language the recipient wrote to us in, if they have.
function recipientLanguage(target) {
  if (!target.conversationId) return null;
  const last = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 3").all(target.conversationId);
  return last.length ? detectLanguage([{ role: 'user', content: last.map((m) => m.text).join('\n') }]) : null;
}

// Turn the owner's instruction ("tell him how are you and introduce yourself") into the message the
// recipient actually reads, written by the assistant on the owner's behalf.
async function composeMessage(cmd, target, owner, language, isEmail) {
  const company = getSetting('company_name');
  const who = owner.name || 'the owner';
  const recipient = String(target.label || '').replace(/\s*[(<].*$/, '').trim();
  const system = [
    `You write ${isEmail ? 'emails' : 'WhatsApp messages'} on behalf of ${who} at ${company}. You are ${who}'s AI assistant.`,
    `${who} asked you: «${cmd.said}»`,
    cmd.text ? `Draft: ${cmd.text}` : '',
    `Write the ${isEmail ? 'email body' : 'message'} that ${recipient && !/^\+?\d/.test(recipient) ? recipient : 'the recipient'} will read. Do what ${who} meant, not their exact words:`,
    `- "tell him / قلو / قلها X" means say X to the recipient directly, in your own words.`,
    `- "introduce yourself / عرفو عن حالك" means say you are ${who}'s assistant${company && company !== 'Our Company' ? ` at ${company}` : ''}.`,
    `- Never copy the instruction words (tell him, قلو, قلها, احكي مع, ابعت لـ, إنو) or any phone number into the message.`,
    '- Greet them naturally. Keep it short, warm and polite.',
    `- Write in ${language}${language === 'Arabic' ? ', in the same dialect the owner used' : ''}, unless ${who} asked for another language. Never use Chinese.`,
    '- Do not mention when it will be sent, do not add a signature line with placeholders, and do not invent facts, prices or promises.',
    'Answer with the message text only.',
  ].filter(Boolean).join('\n');
  try {
    const out = (await chat([{ role: 'system', content: system }, { role: 'user', content: 'Write it now.' }], { temperature: 0.3 })).trim().replace(/^["«“]|["»”]$/g, '').trim();
    if (out && !CJK.test(out)) return cleanDraft(out, target);
  } catch (err) {
    console.error('[assistant] Writing the message failed:', err.message);
  }
  return cmd.text;
}

// --- Finding who to send to ---
function ownerConversationIds() {
  return db
    .prepare("SELECT id FROM conversations WHERE channel IN ('whatsapp', 'telegram')")
    .all()
    .map((r) => r.id)
    .filter((id) => isOwnerConversation(id));
}

function phoneOf(conv) {
  if (conv.meta?.phone) return conv.meta.phone;
  if (conv.external_id.endsWith('@s.whatsapp.net')) return '+' + conv.external_id.split('@')[0];
  return null;
}

// A rough consonant skeleton, so "منى" matches "Mona" and "محمد" matches "Mohammad".
const AR = { ب: 'b', ت: 't', ث: 't', ج: 'j', ح: 'h', خ: 'k', د: 'd', ذ: 'z', ر: 'r', ز: 'z', س: 's', ش: 'x', ص: 's', ض: 'd', ط: 't', ظ: 'z', غ: 'g', ف: 'f', ق: 'k', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h' };
function skeleton(word) {
  let w = String(word || '').toLowerCase();
  if (/[\u0600-\u06FF]/.test(w)) {
    w = [...w.replace(/^ال(?=..)/, '').replace(/[هة]$/, '')].map((ch) => AR[ch] || '').join('');
  } else {
    w = w.replace(/^al-?(?=..)/, '').replace(/(sh|ch)/g, 'x').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/th/g, 't').replace(/dh/g, 'z').replace(/ph/g, 'f')
      .replace(/h$/, '').replace(/[^a-z]/g, '').replace(/[aeiouwy]/g, '').replace(/[cq]/g, 'k').replace(/g/g, 'j').replace(/v/g, 'f').replace(/p/g, 'b');
  }
  return w.replace(/(.)\1+/g, '$1');
}
const nameWords = (name) => String(name || '').split(/[\s.,،_-]+/).filter((w) => w.length >= 2);
function nameMatches(contactName, wanted) {
  const a = String(contactName || '').toLowerCase();
  const b = String(wanted || '').toLowerCase().trim();
  if (!a || !b) return false;
  if (a.includes(b)) return true;
  const want = nameWords(b).map(skeleton).filter((k) => k.length >= 2);
  const have = nameWords(a).map(skeleton);
  return want.length > 0 && want.every((k) => have.includes(k));
}

function contactList() {
  const owners = new Set(ownerConversationIds());
  return db
    .prepare("SELECT * FROM conversations WHERE channel IN ('whatsapp', 'telegram') AND (contact_name IS NOT NULL OR contact_handle IS NOT NULL) ORDER BY last_message_at DESC LIMIT 1000")
    .all()
    .filter((c) => !owners.has(c.id))
    .map((c) => {
      const meta = JSON.parse(c.meta || '{}');
      const where = c.channel === 'whatsapp' ? phoneOf({ ...c, meta }) || 'WhatsApp' : `Telegram ${c.contact_handle || ''}`.trim();
      return { conversationId: c.id, name: c.contact_name || c.contact_handle, handle: c.contact_handle, label: `${c.contact_name || c.contact_handle} (${where})` };
    });
}

function resolveRecipient(to, language, said = '') {
  let wanted = String(to || '').trim();
  // No name from the model: look for a known contact's name in what the owner wrote.
  if (!wanted && said) {
    const words = nameWords(said);
    const hits = contactList().filter((c) => c.name && nameWords(c.name).some((n) => words.some((w) => n.length >= 3 && skeleton(n).length >= 2 && (w.toLowerCase() === n.toLowerCase() || skeleton(w) === skeleton(n)))));
    if (hits.length === 1) return hits[0];
  }
  if (!wanted) return { ask: say(language, 'Who should I send it to? Send me their name or number.', 'لمين بدك ابعتها؟ ابعتلي الاسم أو الرقم.') };
  const digits = digitsOf(wanted);
  if (digits.length >= 7) {
    const conv = db.prepare("SELECT * FROM conversations WHERE channel = 'whatsapp'").all()
      .map((c) => ({ ...c, meta: JSON.parse(c.meta || '{}') }))
      .find((c) => samePhone(phoneOf(c), digits));
    return conv
      ? { conversationId: conv.id, label: `${conv.contact_name || phoneOf(conv)} (${phoneOf(conv)})` }
      : { phone: '+' + digits, label: '+' + digits };
  }
  const found = contactList().filter((c) => nameMatches(c.name, wanted) || String(c.handle || '').toLowerCase().includes(wanted.toLowerCase())).slice(0, 10);
  const team = teamContacts()
    .filter((m) => m.phone && m.name && nameMatches(m.name, wanted))
    .map((m) => ({ phone: m.phone, label: `${m.name} (${m.phone})` }));
  const all = [...found, ...team.filter((t) => !found.some((f) => f.label.includes(digitsOf(t.phone).slice(-9))))];
  if (all.length === 1) return all[0];
  if (!all.length) {
    return { ask: say(language, `I couldn't find "${wanted}" in your chats. Send me their WhatsApp number.`, `ما لقيت "${wanted}" بالمحادثات. ابعتلي رقم الواتساب تبعه.`) };
  }
  const options = all.slice(0, 5).map((r) => `• ${r.label}`).join('\n');
  return { ask: say(language, `I found more than one "${wanted}":\n${options}\nSend the request again with the number.`, `لقيت أكتر من "${wanted}":\n${options}\nابعت الطلب مرة تانية مع الرقم.`) };
}

function resolveEmail(to, language) {
  const wanted = String(to || '').trim();
  const address = wanted.match(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/)?.[0];
  if (address) return { address, label: address };
  if (!wanted) return { ask: say(language, 'Which email address should I send it to?', 'لأي إيميل بدك ابعتها؟') };
  const like = `%${wanted}%`;
  const found = db.prepare("SELECT contact_name, external_id FROM conversations WHERE channel = 'email' AND contact_name LIKE ? LIMIT 5").all(like)
    .map((c) => ({ address: c.external_id, label: `${c.contact_name} <${c.external_id}>` }));
  const team = teamContacts().filter((m) => m.email && m.name?.toLowerCase().includes(wanted.toLowerCase()))
    .map((m) => ({ address: m.email, label: `${m.name} <${m.email}>` }));
  const all = [...found, ...team];
  if (all.length === 1) return all[0];
  return { ask: say(language, `I don't have an email address for "${wanted}". Send me the address.`, `ما عندي إيميل لـ "${wanted}". ابعتلي العنوان.`) };
}

// --- Doing things ---
async function sendToRecipient(target, text, owner) {
  let conversationId = target.conversationId;
  if (!conversationId) {
    const digits = digitsOf(target.phone);
    conversationId = ensureConversation({ channel: 'whatsapp', externalId: `${digits}@s.whatsapp.net`, handle: '+' + digits, convMeta: { phone: '+' + digits } });
  }
  const msg = await sendMessage(conversationId, text, { sender: 'agent', meta: { byAssistant: owner?.name || true } });
  if (msg.error) throw new Error(msg.error);
}

async function sendEmailNow(target, subject, text) {
  const send = outboundSenders().email;
  if (!send) throw new Error('No email account is set up');
  await send(target.address, subject, text);
}

async function carryOut(action, conv, owner, language) {
  const tz = timeZone();
  const later = action.when && new Date(action.when).getTime() > Date.now() + 60e3;
  if (later) {
    const id = insertTask({
      kind: action.kind,
      conv,
      owner,
      runAt: new Date(action.when),
      payload: { ...action, language },
    });
    return say(language, `🕒 Scheduled #${id} for ${pretty(new Date(action.when), tz, language)}.`, `🕒 تمت الجدولة #${id} بتاريخ ${pretty(new Date(action.when), tz, language)}.`);
  }
  try {
    if (action.kind === 'message') await sendToRecipient(action, action.text, owner);
    else await sendEmailNow(action, action.subject, action.text);
    return say(language, `✅ Sent to ${action.label}.`, `✅ تم الإرسال إلى ${action.label}.`);
  } catch (err) {
    return say(language, `⚠️ Could not send to ${action.label}: ${err.message}`, `⚠️ ما قدرت ابعت لـ ${action.label}: ${err.message}`);
  }
}

function needTime(cmd, language) {
  const when = cmd.when ? fromLocal(cmd.when, timeZone()) : null;
  if (!when) return { ask: say(language, 'When? For example "tomorrow at 9:00".', 'إيمتى؟ مثلاً "بكرا الساعة 9".') };
  if (when.getTime() < Date.now() - 60e3) return { ask: say(language, `${pretty(when, timeZone(), language)} has already passed. When should it be?`, `${pretty(when, timeZone(), language)} صار ماضي. إيمتى بدك ياها؟`) };
  return { when };
}

function helpText(language) {
  return say(language,
    'I can:\n• ⏰ Remind you: "remind me tomorrow at 9 to call Ahmad"\n• 📅 Save appointments: "meeting with Sami Thursday at 4"\n• 💬 Message a client: "tell Huda her order is ready" (now or at a time)\n• ✉️ Send an email: "email sami@x.com the price list"\n• 📋 "what do I have tomorrow?" · "cancel #12" · "summary of today"\nVoice notes work too.',
    'بقدر:\n• ⏰ ذكّرك: "ذكرني بكرا الساعة 9 اتصل بأحمد"\n• 📅 احفظ مواعيد: "عندي اجتماع مع سامي الخميس الساعة 4"\n• 💬 ابعت رسالة لزبون: "قول لهدى إنو طلبها جاهز" (هلق أو بوقت محدد)\n• ✉️ ابعت إيميل: "ابعت لـ sami@x.com قائمة الأسعار"\n• 📋 "شو عندي بكرا؟" · "الغي #12" · "ملخص اليوم"\nوالرسائل الصوتية كمان بتشتغل.');
}

export function todaySummary(language, ownerConvId = null) {
  const tz = timeZone();
  const { start, end } = localDayBounds(new Date(), tz);
  const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const owners = new Set(ownerConversationIds());
  const convs = db.prepare('SELECT id FROM conversations WHERE created_at >= ? AND created_at < ?').all(sql(start), sql(end)).filter((c) => !owners.has(c.id)).length;
  const incoming = db.prepare("SELECT conversation_id FROM messages WHERE direction = 'in' AND created_at >= ? AND created_at < ?").all(sql(start), sql(end)).filter((m) => !owners.has(m.conversation_id)).length;
  const handed = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'note' AND text LIKE 'Sent to % team%' AND created_at >= ? AND created_at < ?").get(sql(start), sql(end)).n;
  const unread = db.prepare('SELECT id, unread FROM conversations WHERE unread > 0').all().filter((c) => !owners.has(c.id)).length;
  const tasks = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND run_at < ? ORDER BY run_at").all(end.toISOString())
    .filter((t) => ownerConvId == null || t.owner_conversation_id === ownerConvId || t.owner_conversation_id == null);
  const lines = [
    say(language, `📊 Today (${pretty(new Date(), tz, language).split(',')[0]}):`, `📊 اليوم (${pretty(new Date(), tz, language).split('،')[0]}):`),
    say(language, `• New chats: ${convs}`, `• محادثات جديدة: ${convs}`),
    say(language, `• Customer messages: ${incoming}`, `• رسائل الزبائن: ${incoming}`),
    say(language, `• Requests passed to the team: ${handed}`, `• طلبات انبعتت للفريق: ${handed}`),
    say(language, `• Chats with unread messages: ${unread}`, `• محادثات فيها رسائل ما انقرت: ${unread}`),
  ];
  lines.push(tasks.length
    ? say(language, '\nStill to do today:', '\nباقي لليوم:') + '\n' + tasks.map((t) => describeTask(t, language)).join('\n')
    : say(language, '\nNothing else scheduled today.', '\nما في شي تاني مجدول لليوم.'));
  return lines.join('\n');
}

async function act(cmd, conv, owner, language) {
  const tz = timeZone();
  const s = assistantSettings();
  switch (cmd.action) {
    case 'reminder': {
      const t = needTime(cmd, language);
      if (t.ask) return asking(t.ask);
      const text = cmd.text || say(language, 'Reminder', 'تذكير');
      const id = insertTask({ kind: 'reminder', conv, owner, runAt: t.when, payload: { text, language } });
      return say(language, `⏰ Reminder #${id} set for ${pretty(t.when, tz, language)}: ${text}`, `⏰ تم ضبط التذكير #${id} بتاريخ ${pretty(t.when, tz, language)}: ${text}`);
    }
    case 'schedule': {
      const t = needTime(cmd, language);
      if (t.ask) return asking(t.ask);
      const title = cmd.text || say(language, 'Appointment', 'موعد');
      const before = s.event_reminder_minutes ?? 30;
      const remindAt = new Date(Math.max(Date.now(), t.when.getTime() - before * 60e3));
      const id = insertTask({ kind: 'event', conv, owner, runAt: remindAt, payload: { title, event_at: t.when.toISOString(), language } });
      return say(language,
        `📅 Saved #${id}: ${title}, ${pretty(t.when, tz, language)}.${before ? ` I'll remind you ${before} min before.` : ''}`,
        `📅 انحفظ #${id}: ${title}، ${pretty(t.when, tz, language)}.${before ? ` رح ذكّرك قبل ${before} دقيقة.` : ''}`);
    }
    case 'send_message':
    case 'send_email': {
      const isEmail = cmd.action === 'send_email';
      const target = isEmail ? resolveEmail(cmd.to, language) : resolveRecipient(cmd.to, language, cmd.said);
      if (target.ask) return asking(target.ask);
      // Words in quotes ("…", «…») are sent as written; anything else is an instruction the assistant carries out.
      const quoted = String(cmd.said || '').match(/["“«]([^"”»]{2,})["”»]/)?.[1]?.trim();
      if (quoted || /بالحرف|word for word|exactly/i.test(cmd.said || '')) cmd.text = quoted || cmd.text;
      else if (cmd.said) cmd.text = await composeMessage(cmd, target, owner, recipientLanguage(target) || language, isEmail);
      if (!cmd.text) return asking(say(language, 'What should the message say?', 'شو بدك تقول الرسالة؟'));
      let when = null;
      if (cmd.when) {
        const t = needTime(cmd, language);
        if (t.ask) return asking(t.ask);
        when = t.when.toISOString();
      }
      const action = {
        kind: isEmail ? 'email' : 'message',
        ...target,
        text: cmd.text,
        subject: isEmail ? cmd.subject || say(language, `Message from ${getSetting('company_name')}`, `رسالة من ${getSetting('company_name')}`) : null,
        when,
      };
      if (!s.confirm_before_sending) return carryOut(action, conv, owner, language);
      updateMeta(conv.id, { assistantPending: { action, at: Date.now() } });
      const timing = when ? say(language, ` on ${pretty(new Date(when), tz, language)}`, ` بتاريخ ${pretty(new Date(when), tz, language)}`) : say(language, ' now', ' هلق');
      const head = isEmail
        ? say(language, `✉️ Email to ${target.label}${timing}\nSubject: ${action.subject}`, `✉️ إيميل إلى ${target.label}${timing}\nالموضوع: ${action.subject}`)
        : say(language, `💬 WhatsApp to ${target.label}${timing}:`, `💬 واتساب إلى ${target.label}${timing}:`);
      return `${head}\n\n${cmd.text}\n\n${say(language, 'Reply "yes" to send or "no" to cancel.', 'رد "نعم" للإرسال أو "لا" للإلغاء.')}`;
    }
    case 'list': {
      let rows = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND (owner_conversation_id = ? OR owner_conversation_id IS NULL) ORDER BY run_at LIMIT 30").all(conv.id);
      let title = say(language, '📋 Coming up:', '📋 الجاي:');
      const day = cmd.when ? fromLocal(cmd.when.length <= 10 ? `${cmd.when} 12:00` : cmd.when, tz) : null;
      if (day) {
        const { start, end } = localDayBounds(day, tz);
        rows = rows.filter((t) => {
          const at = new Date(JSON.parse(t.payload).event_at || t.run_at);
          return at >= start && at < end;
        });
        title = say(language, `📋 ${pretty(day, tz, language).split(',')[0]}:`, `📋 ${pretty(day, tz, language).split('،')[0]}:`);
      }
      if (!rows.length) return say(language, 'Nothing scheduled.', 'ما في شي مجدول.');
      return `${title}\n${rows.slice(0, 15).map((t) => describeTask(t, language)).join('\n')}`;
    }
    case 'cancel': {
      const id = Number(cmd.task_id || String(cmd.text || '').match(/\d+/)?.[0]);
      const t = id && db.prepare("SELECT * FROM tasks WHERE id = ? AND status = 'pending' AND (owner_conversation_id = ? OR owner_conversation_id IS NULL)").get(id, conv.id);
      if (!t) return asking(say(language, 'Which task number? Send "list" to see them.', 'أي رقم مهمة؟ ابعت "شو عندي" لتشوفهم.'));
      finishTask(id, 'cancelled', `Cancelled by ${owner.name || 'owner'}`);
      return say(language, `🗑️ Cancelled #${id}.`, `🗑️ انلغت #${id}.`);
    }
    case 'summary':
      return todaySummary(language, conv.id);
    case 'help':
      return helpText(language);
    default:
      return cmd.reply || helpText(language);
  }
}

// --- Entry point from the inbox ---
const YES = new Set(['yes', 'y', 'ok', 'okay', 'sure', 'send', 'confirm', 'yep', 'نعم', 'اي', 'أي', 'ايه', 'إيه', 'ايوه', 'أيوه', 'اكيد', 'أكيد', 'تمام', 'ماشي', 'ارسل', 'أرسل', 'ابعت', 'ابعث', 'موافق', 'يلا', '👍', '✅']);
const NO = new Set(['no', 'n', 'cancel', 'stop', 'nope', 'لا', 'لأ', 'الغي', 'ألغي', 'إلغاء', 'الغاء', 'بلا', '❌']);
const firstWord = (text) => String(text || '').trim().toLowerCase().replace(/[.!؟?,،]+/g, ' ').split(/\s+/)[0] || '';

let chain = Promise.resolve();
export function handleOwnerMessage(conversationId) {
  const run = chain.then(() => processOwnerMessage(conversationId));
  chain = run.catch((err) => console.error('[assistant]', err));
  return run;
}

async function processOwnerMessage(conversationId) {
  const conv = getConversation(conversationId);
  const owner = ownerOf(conv);
  if (!owner) return;
  const text = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(conversationId)?.text || '';
  const language = detectLanguage([{ role: 'user', content: text }]);
  const reply = (body) => sendMessage(conversationId, body, { sender: 'ai', meta: { assistant: true } });

  emit('typing', { conversationId, typing: true });
  try {
    const pending = conv.meta.assistantPending;
    if (pending && Date.now() - pending.at < CONFIRM_MINUTES * 60e3) {
      const word = firstWord(text);
      if (YES.has(word)) {
        updateMeta(conversationId, { assistantPending: null });
        return await reply(await carryOut(pending.action, conv, owner, language));
      }
      if (NO.has(word)) {
        updateMeta(conversationId, { assistantPending: null });
        return await reply(say(language, 'OK, not sent.', 'تمام، ما انبعتت.'));
      }
    }
    const asked = conv.meta.assistantAsked;
    if (asked && Date.now() - asked < CONFIRM_MINUTES * 60e3 && NO.has(firstWord(text))) {
      updateMeta(conversationId, { assistantPending: null, assistantAsked: null });
      return await reply(say(language, 'OK, cancelled.', 'تمام، انلغى.'));
    }
    if (pending || asked) updateMeta(conversationId, { assistantPending: null, assistantAsked: null });
    const cmd = await understand(conv, owner, language, text);
    const out = await act(cmd, getConversation(conversationId), owner, language);
    if (out?.ask) {
      updateMeta(conversationId, { assistantAsked: Date.now() });
      await reply(out.ask);
    } else {
      await reply(out);
    }
  } catch (err) {
    console.error('[assistant] Failed:', err);
    await reply(say(language, `⚠️ Something went wrong: ${err.message}`, `⚠️ صار خطأ: ${err.message}`));
  } finally {
    emit('typing', { conversationId, typing: false });
  }
}

// --- Scheduler ---
async function runTask(t, now) {
  const p = JSON.parse(t.payload || '{}');
  const language = p.language || 'English';
  const tz = timeZone();
  const notify = (text) => (t.owner_conversation_id ? sendMessage(t.owner_conversation_id, text, { sender: 'ai', meta: { assistant: true, taskId: t.id } }) : null);
  const late = now.getTime() - new Date(t.run_at).getTime() > 10 * 60e3
    ? say(language, ` (late: it was due ${pretty(new Date(t.run_at), tz, language)})`, ` (متأخر: كان موعده ${pretty(new Date(t.run_at), tz, language)})`)
    : '';
  if (t.kind === 'reminder') {
    await notify(`${say(language, '⏰ Reminder', '⏰ تذكير')}: ${p.text}${late}`);
  } else if (t.kind === 'event') {
    const mins = Math.max(0, Math.round((new Date(p.event_at).getTime() - now.getTime()) / 60e3));
    await notify(mins > 0
      ? say(language, `📅 In ${mins} min: ${p.title} (${pretty(new Date(p.event_at), tz, language)})`, `📅 بعد ${mins} دقيقة: ${p.title} (${pretty(new Date(p.event_at), tz, language)})`)
      : say(language, `📅 Now: ${p.title}`, `📅 هلق: ${p.title}`));
  } else if (t.kind === 'message' || t.kind === 'email') {
    try {
      if (t.kind === 'message') await sendToRecipient(p, p.text, { name: t.owner_name });
      else await sendEmailNow(p, p.subject, p.text);
    } catch (err) {
      await notify(say(language, `⚠️ Scheduled #${t.id} to ${p.label} failed: ${err.message}`, `⚠️ المجدولة #${t.id} لـ ${p.label} ما انبعتت: ${err.message}`));
      throw err;
    }
    await notify(say(language, `✅ Sent #${t.id} to ${p.label}.`, `✅ انبعتت #${t.id} لـ ${p.label}.`));
  }
}

// Send each owner the day's summary once, at the time set under Assistant.
async function dailyBriefings(now) {
  const s = assistantSettings();
  if (!s.enabled || !s.daily_briefing) return;
  const tz = timeZone();
  const at = fromLocal(`${toLocal(now, tz).slice(0, 10)} ${s.daily_briefing}`, tz);
  if (!at || now < at || now.getTime() - at.getTime() > 3 * 3600e3) return;
  for (const id of ownerConversationIds()) {
    const done = db.prepare("SELECT 1 FROM tasks WHERE kind = 'briefing' AND owner_conversation_id = ? AND run_at = ?").get(id, at.toISOString());
    if (done) continue;
    const owner = ownerOf(getConversation(id));
    const last = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(id)?.text || '';
    const language = detectLanguage([{ role: 'user', content: last }]);
    const taskId = insertTask({ kind: 'briefing', conv: { id }, owner, runAt: at, payload: { language } });
    try {
      await sendMessage(id, `${say(language, '☀️ Good morning!', '☀️ صباح الخير!')}\n${todaySummary(language, id)}`, { sender: 'ai', meta: { assistant: true } });
      finishTask(taskId, 'done', 'Sent');
    } catch (err) {
      finishTask(taskId, 'failed', err.message);
    }
  }
}

let running = false;
export async function runDueTasks(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const due = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND kind <> 'briefing' AND run_at <= ? ORDER BY run_at").all(now.toISOString());
    for (const t of due) {
      try {
        await runTask(t, now);
        finishTask(t.id, 'done', 'Done');
      } catch (err) {
        console.error(`[assistant] Task #${t.id} failed:`, err.message);
        finishTask(t.id, 'failed', err.message);
      }
    }
    await dailyBriefings(now);
  } finally {
    running = false;
  }
}

let timer = null;
export function startScheduler() {
  clearInterval(timer);
  timer = setInterval(() => runDueTasks().catch((err) => console.error('[assistant] Scheduler:', err)), 20e3);
  timer.unref?.();
  runDueTasks().catch(() => {});
}
