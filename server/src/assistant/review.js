import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from '../ai/ollama.js';
import { search, createSource, indexSource } from '../kb/index.js';
import { withoutPhoto } from '../ai/vision.js';
import { emit } from '../realtime.js';
import { listWishes } from './skills.js';

// Self-improvement, always with the owner's approval:
// - The team's own replies to customers (typed in the inbox) are read for knowledge worth keeping.
// - Once a week the AI reviews its chats: what it could not answer, and what the team taught it.
// Proposals wait in `suggestions` until an owner says yes (by WhatsApp or in the dashboard).

const DAYS = 7;
const MAX_ITEMS = 12;
const SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'boolean' },
    title: { type: 'string' },
    question: { type: 'string' },
    answer: { type: 'string' },
  },
  required: ['keep'],
};
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const parse = (m) => JSON.parse(m || '{}');

export function listSuggestions({ status } = {}) {
  return status
    ? db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY id DESC LIMIT 200').all(status)
    : db.prepare('SELECT * FROM suggestions ORDER BY id DESC LIMIT 200').all();
}

export function decideSuggestions(ids, approve) {
  const out = [];
  for (const id of ids) {
    const s = db.prepare("SELECT * FROM suggestions WHERE id = ? AND status = 'pending'").get(id);
    if (!s) continue;
    let sourceId = null;
    if (approve) {
      sourceId = createSource({ type: 'text', title: `🧠 ${s.title}`, origin: null, content: s.content });
      indexSource(sourceId).catch(() => {});
    }
    db.prepare("UPDATE suggestions SET status = ?, source_id = ?, decided_at = datetime('now') WHERE id = ?").run(approve ? 'approved' : 'rejected', sourceId, id);
    out.push(s);
  }
  if (out.length) emit('suggestions', { changed: true });
  return out;
}

// Team replies (and the customer messages they answer) from the last week that weren't looked at yet.
function teamReplies(since, skip) {
  return db.prepare(
    `SELECT m.id, m.conversation_id, m.text, m.meta FROM messages m
     WHERE m.direction = 'out' AND m.sender = 'agent' AND m.error IS NULL AND m.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.message_id = m.id)
     ORDER BY m.id DESC LIMIT 60`,
  ).all(sqlTime(since))
    .filter((m) => !skip.has(m.conversation_id))
    .filter((m) => { const meta = parse(m.meta); return !meta.byAssistant && !meta.audio; })
    .filter((m) => m.text.length >= 15)
    .map((m) => {
      const asked = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' AND id < ? ORDER BY id DESC LIMIT 2")
        .all(m.conversation_id, m.id).reverse().map((r) => withoutPhoto(r.text)).join('\n');
      return { ...m, asked };
    })
    .filter((m) => m.asked.trim());
}

// Customer questions the AI couldn't answer, and nobody answered since.
function openQuestions(since, skip) {
  return db.prepare(
    `SELECT m.id, m.conversation_id, m.meta FROM messages m
     WHERE m.direction = 'out' AND m.sender = 'ai' AND m.created_at >= ? AND m.meta LIKE '%"unsure":true%'
     ORDER BY m.id DESC LIMIT 40`,
  ).all(sqlTime(since))
    .filter((m) => !skip.has(m.conversation_id))
    .filter((m) => !db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND id > ? AND direction = 'out' AND sender = 'agent'").get(m.conversation_id, m.id))
    .map((m) => db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' AND id < ? ORDER BY id DESC LIMIT 1").get(m.conversation_id, m.id)?.text)
    .filter(Boolean)
    .map((t) => withoutPhoto(t).replace(/\s+/g, ' ').slice(0, 160));
}

// Is this team reply general knowledge (useful for other customers), and if so, as a short Q&A.
async function lesson(item) {
  const raw = await chat([
    { role: 'system', content: [
      `You help the customer-service AI of ${getSetting('company_name')} learn from its human team.`,
      'Below is a customer message and the reply a team member wrote. Decide if the reply contains company knowledge that would help answer OTHER customers too (prices, policies, opening hours, services, delivery, warranty, how-to).',
      'keep = false if it is only about this one customer (their order, their appointment, personal details, a greeting, small talk, "we will call you").',
      'If keep = true: title = a short topic (max 8 words); question = the general question in plain words; answer = the general answer, using only facts from the team reply, without names, phone numbers or order numbers of this customer.',
      'Write title, question and answer in the language of the team reply. Never use Chinese. Answer with JSON only.',
    ].join('\n') },
    { role: 'user', content: `Customer: «${item.asked.slice(0, 600)}»\nTeam reply: «${item.text.slice(0, 800)}»` },
  ], { temperature: 0, format: SCHEMA });
  let out;
  try {
    out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  if (!out.keep || !out.answer || !out.title || CJK.test(JSON.stringify(out))) return null;
  // The customer's own number must never end up in Knowledge.
  if (/\+?\d[\d\s-]{7,}\d/.test(out.answer) && !/\+?\d[\d\s-]{7,}\d/.test(getSetting('system_prompt'))) {
    const digits = (s) => String(s).replace(/\D/g, '');
    const conv = db.prepare('SELECT contact_handle, external_id FROM conversations WHERE id = ?').get(item.conversation_id);
    const theirs = digits(conv?.contact_handle || conv?.external_id || '').slice(-7);
    if (theirs && digits(out.answer).includes(theirs)) return null;
  }
  return {
    title: String(out.title).trim().slice(0, 80),
    content: `${out.question ? `Question: ${String(out.question).trim()}\n` : ''}Answer: ${String(out.answer).trim()}`,
  };
}

// Already in Knowledge? Then there's nothing new to learn.
async function known(content) {
  try {
    const [best] = await search(content, { k: 1, minScore: 0 });
    return !!best && best.score >= 0.85;
  } catch {
    return false;
  }
}

// Read the last week and propose what to learn. Returns { added: [suggestions], open: [questions] }.
export async function reviewChats({ ownerConversationIds = [] } = {}) {
  const since = new Date(Date.now() - DAYS * 86400e3);
  const skip = new Set(ownerConversationIds);
  const added = [];
  for (const item of teamReplies(since, skip).slice(0, MAX_ITEMS)) {
    let l = null;
    try {
      l = await lesson(item);
    } catch (err) {
      console.warn('[review] Could not read a team reply:', err.message);
      continue;
    }
    if (l && !(await known(l.content)) && !added.some((a) => a.title === l.title)) {
      const info = db.prepare("INSERT OR IGNORE INTO suggestions (kind, title, content, reason, message_id, conversation_id) VALUES ('knowledge', ?, ?, 'team reply', ?, ?)")
        .run(l.title, l.content, item.id, item.conversation_id);
      if (info.changes) added.push(db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid));
    } else {
      // Remember it was looked at, so it isn't read again next week.
      db.prepare("INSERT OR IGNORE INTO suggestions (kind, title, content, reason, message_id, conversation_id, status) VALUES ('knowledge', '-', '-', 'not general', ?, ?, 'rejected')")
        .run(item.id, item.conversation_id);
    }
  }
  const open = [...new Set(openQuestions(since, skip))].slice(0, 8);
  if (added.length) emit('suggestions', { changed: true });
  return { added, open };
}

const say = (language, en, ar) => (language === 'Arabic' ? ar : en);

// The WhatsApp message to the owner.
export function reviewMessage({ added, open }, language) {
  const pending = listSuggestions({ status: 'pending' });
  const lines = [say(language, '🧠 My weekly self-review', '🧠 مراجعتي الأسبوعية لحالي')];
  if (pending.length) {
    lines.push('', say(language, `From your team's replies, I'd like to learn ${pending.length === 1 ? 'this' : `these ${pending.length} things`}:`, `من ردود فريقك، حابب اتعلم ${pending.length === 1 ? 'هالشي' : `هدول الـ ${pending.length}`}:`));
    pending.slice(0, 10).forEach((s, i) => lines.push(`${i + 1}. ${s.title}\n   ${s.content.replace(/^Question: .*\n/, '').replace(/^Answer: /, '').slice(0, 220)}`));
  }
  if (open.length) {
    lines.push('', say(language, "Customers asked these and I didn't know (send me the answers any time, or add them on the Knowledge page):", 'زبائن سألوا هدول وما عرفت (ابعتلي الأجوبة أي وقت، أو ضيفها من صفحة Knowledge):'));
    open.forEach((q) => lines.push(`• ${q}`));
  }
  const wishes = listWishes().slice(0, 5);
  if (wishes.length) {
    lines.push('', say(language, "Things you asked for that I can't do yet (on my list for the developer):", 'أشياء طلبتها وما بقدر اعملها لسا (على قائمتي للمطور):'));
    wishes.forEach((w) => lines.push(`• ${w.text}${w.times > 1 ? ` (×${w.times})` : ''}`));
  }
  if (!pending.length && !open.length && !wishes.length) return null;
  if (pending.length) lines.push('', say(language, 'Reply "yes" to learn all, numbers to pick (e.g. "1 3"), or "no".', 'رد "نعم" لاتعلمهم كلهم، أو أرقام لتختار (مثلاً "1 3")، أو "لا".'));
  return { text: lines.join('\n'), ids: pending.slice(0, 10).map((s) => s.id) };
}

export function reviewSettings() {
  return getSetting('self_review');
}
