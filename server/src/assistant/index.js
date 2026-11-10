import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from '../ai/ollama.js';
import { detectLanguage } from '../ai/agent.js';
import { getConversation, sendMessage, updateMeta, ensureConversation } from '../inbox.js';
import { outboundSenders, teamContacts } from '../handoff.js';
import { emit } from '../realtime.js';
import { fromLocal, toLocal, nowContext, pretty, localDayBounds, validTimeZone } from './time.js';

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
    '- when: the local date and time as "YYYY-MM-DD HH:mm", or null for "now" / not given. Work out words like tomorrow, Thursday, بكرا, بعد ساعة, الأحد. If only a day is given for a reminder, use 09:00.',
    '- text: the reminder text, the appointment title, or the exact message or email body to send. Write a message to a recipient as addressed to them, in the language the owner wants it in.',
    '- to: for send_message the person\'s name or phone number exactly as the owner gave it; for send_email the email address or name. Otherwise null.',
    '- subject: the email subject, or null.',
    '- task_id: for cancel, the task number. Otherwise null.',
    `- reply: for help or chat, a short answer in ${language}. Otherwise "".`,
    'Answer with the JSON object only.',
  ].join('\n');
}

async function understand(conv, owner, language) {
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
  return cmd;
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

function resolveRecipient(to, language) {
  const wanted = String(to || '').trim();
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
  const owners = new Set(ownerConversationIds());
  const like = `%${wanted}%`;
  const found = db
    .prepare("SELECT * FROM conversations WHERE channel IN ('whatsapp', 'telegram') AND (contact_name LIKE ? OR contact_handle LIKE ?) ORDER BY last_message_at DESC LIMIT 10")
    .all(like, like)
    .filter((c) => !owners.has(c.id))
    .map((c) => {
      const meta = JSON.parse(c.meta || '{}');
      const where = c.channel === 'whatsapp' ? phoneOf({ ...c, meta }) || 'WhatsApp' : `Telegram ${c.contact_handle || ''}`.trim();
      return { conversationId: c.id, label: `${c.contact_name || c.contact_handle} (${where})` };
    });
  const team = teamContacts()
    .filter((m) => m.phone && m.name && m.name.toLowerCase().includes(wanted.toLowerCase()))
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
      if (t.ask) return t.ask;
      const text = cmd.text || say(language, 'Reminder', 'تذكير');
      const id = insertTask({ kind: 'reminder', conv, owner, runAt: t.when, payload: { text, language } });
      return say(language, `⏰ Reminder #${id} set for ${pretty(t.when, tz, language)}: ${text}`, `⏰ تم ضبط التذكير #${id} بتاريخ ${pretty(t.when, tz, language)}: ${text}`);
    }
    case 'schedule': {
      const t = needTime(cmd, language);
      if (t.ask) return t.ask;
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
      if (!cmd.text) return say(language, 'What should the message say?', 'شو بدك تقول الرسالة؟');
      const target = isEmail ? resolveEmail(cmd.to, language) : resolveRecipient(cmd.to, language);
      if (target.ask) return target.ask;
      let when = null;
      if (cmd.when) {
        const t = needTime(cmd, language);
        if (t.ask) return t.ask;
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
      if (!t) return say(language, 'Which task number? Send "list" to see them.', 'أي رقم مهمة؟ ابعت "شو عندي" لتشوفهم.');
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
    if (pending) updateMeta(conversationId, { assistantPending: null });
    const cmd = await understand(conv, owner, language);
    await reply(await act(cmd, getConversation(conversationId), owner, language));
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
