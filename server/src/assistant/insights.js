import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from '../ai/ollama.js';
import { detectLanguage } from '../ai/agent.js';
import { withoutPhoto } from '../ai/vision.js';
import { simplify } from '../handoff.js';
import { toLocal } from './time.js';

// Follow-ups, the weekly business report and the customer memory.

const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const fromSql = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;
const say = (language, en, ar) => (language === 'Arabic' ? ar : en);

// --- Follow-ups: customers who asked about prices or buying and then went quiet ---
const INTEREST = 'price, prices, how much, cost, quote, buy, purchase, order, available, in stock, سعر, اسعار, بكم, قديش, قداش, كم سعر, اشتري, شراء, بدي اطلب, عرض سعر, متوفر, موجود عندكم';

function interestWords() {
  const sales = (getSetting('handoff').categories || []).find((c) => c.id === 'sales')?.keywords || '';
  return [...new Set(`${INTEREST}, ${sales}`.split(/[,،\n]/).map((k) => simplify(k).trim()).filter(Boolean))];
}

export function showsInterest(text) {
  const t = ` ${simplify(withoutPhoto(text)).replace(/[^\p{L}\p{N}\s]/gu, ' ')} `.replace(/\s+/g, ' ');
  return interestWords().some((k) => (k.length <= 3 ? t.includes(` ${k} `) : t.includes(k)));
}

// Chats where the customer showed interest, we answered, and nothing came back for `hours`.
export function quietLeads({ hours = 24, now = new Date(), skip = new Set(), includeFollowedUp = false } = {}) {
  const oldest = new Date(now.getTime() - 7 * 86400e3);
  const convs = db.prepare(
    `SELECT * FROM conversations WHERE channel IN ('whatsapp', 'telegram', 'facebook', 'instagram') AND last_message_at >= ? AND last_message_at <= ?`,
  ).all(sqlTime(oldest), sqlTime(new Date(now.getTime() - hours * 3600e3)));
  const out = [];
  for (const c of convs) {
    if (skip.has(c.id)) continue;
    const meta = JSON.parse(c.meta || '{}');
    if (meta.group) continue; // no sales follow-ups in groups
    const last = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND direction IN ('in', 'out') ORDER BY id DESC LIMIT 1").get(c.id);
    if (!last || last.direction !== 'out' || last.error) continue;
    const ins = db.prepare("SELECT id, text, created_at FROM messages WHERE conversation_id = ? AND direction = 'in' AND created_at >= ? ORDER BY id DESC LIMIT 5").all(c.id, sqlTime(oldest));
    const asked = ins.find((m) => showsInterest(m.text));
    if (!asked) continue;
    if (!includeFollowedUp && meta.followedUpAt && meta.followedUpAt >= fromSql(ins[0].created_at).getTime()) continue;
    const handed = Math.max(0, ...Object.values(meta.handoffs || {}).map(Number).filter(Boolean));
    if (handed && now.getTime() - handed < 3 * 86400e3) continue; // the team is already on it
    out.push({ conversationId: c.id, name: c.contact_name || null, handle: meta.phone || c.contact_handle || '', asked: withoutPhoto(asked.text).replace(/\s+/g, ' ').slice(0, 140), at: last.created_at });
  }
  return out;
}

export function followupText(lead) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(lead.conversationId);
  const texts = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 3").all(lead.conversationId).map((m) => ({ role: 'user', content: withoutPhoto(m.text) }));
  const language = detectLanguage(texts);
  const s = getSetting('followups');
  const name = conv?.contact_name && !/^\+?\d/.test(conv.contact_name) ? ` ${conv.contact_name.split(/\s+/)[0]}` : '';
  const template = language === 'Arabic' ? s.message_ar : s.message_en;
  return template.replace(/\s*\{name\}/g, name);
}

// --- Weekly report ---
export async function weeklyReport({ language = 'English', skip = new Set(), now = new Date() } = {}) {
  const tz = getSetting('assistant').timezone;
  const since = new Date(now.getTime() - 7 * 86400e3);
  const convs = db.prepare('SELECT id, channel FROM conversations WHERE created_at >= ?').all(sqlTime(since)).filter((c) => !skip.has(c.id));
  const ins = db.prepare("SELECT conversation_id, text, created_at FROM messages WHERE direction = 'in' AND created_at >= ?").all(sqlTime(since)).filter((m) => !skip.has(m.conversation_id));
  const unsure = db.prepare("SELECT conversation_id FROM messages WHERE direction = 'out' AND sender = 'ai' AND created_at >= ? AND meta LIKE '%\"unsure\":true%'").all(sqlTime(since)).length;
  const handed = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'note' AND text LIKE 'Sent to % team%' AND created_at >= ?").get(sqlTime(since)).n;
  const quiet = quietLeads({ hours: 24, now, skip, includeFollowedUp: true });

  const hours = new Map();
  const days = new Map();
  for (const m of ins) {
    const local = toLocal(fromSql(m.created_at), tz);
    hours.set(local.slice(11, 13), (hours.get(local.slice(11, 13)) || 0) + 1);
    const day = new Date(`${local.slice(0, 10)}T12:00:00Z`).toLocaleDateString(language === 'Arabic' ? 'ar' : 'en-US', { weekday: 'long', timeZone: 'UTC' });
    days.set(day, (days.get(day) || 0) + 1);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const channels = new Map();
  for (const c of convs) channels.set(c.channel, (channels.get(c.channel) || 0) + 1);

  const lines = [
    say(language, '📈 Weekly report (last 7 days)', '📈 تقرير الأسبوع (آخر 7 أيام)'),
    say(language, `• New chats: ${convs.length}${channels.size ? ` (${top(channels, 5).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`, `• محادثات جديدة: ${convs.length}${channels.size ? ` (${top(channels, 5).map(([k, v]) => `${k} ${v}`).join('، ')})` : ''}`),
    say(language, `• Customer messages: ${ins.length}`, `• رسائل الزبائن: ${ins.length}`),
    say(language, `• Passed to the team: ${handed}`, `• انبعتت للفريق: ${handed}`),
    say(language, `• Questions the AI couldn't answer: ${unsure}`, `• أسئلة ما عرف الذكاء يجاوب عليها: ${unsure}`),
    say(language, `• Asked about prices and went quiet: ${quiet.length}`, `• سألوا عن أسعار وما رجعوا: ${quiet.length}`),
  ];
  if (ins.length) {
    lines.push(say(language, `• Busiest hours: ${top(hours, 3).map(([h, n]) => `${h}:00 (${n})`).join(', ')}`, `• أكتر ساعات ضغط: ${top(hours, 3).map(([h, n]) => `${h}:00 (${n})`).join('، ')}`));
    lines.push(say(language, `• Busiest day: ${top(days, 1)[0][0]}`, `• أكتر يوم ضغط: ${top(days, 1)[0][0]}`));
  }
  // What people asked about most, in a few words each.
  const sample = ins.map((m) => withoutPhoto(m.text).replace(/\s+/g, ' ').slice(0, 120)).filter((t) => t.length > 8).slice(-60);
  if (sample.length >= 3) {
    try {
      const topics = await chat([
        { role: 'system', content: `These are customer messages to ${getSetting('company_name')} this week. List the 3 to 5 most common topics, most common first, one per line as "- topic (about N messages)". In ${language}, short, no other text, never Chinese.` },
        { role: 'user', content: sample.map((t) => `• ${t}`).join('\n') },
      ], { temperature: 0 });
      const clean = topics.split('\n').map((l) => l.trim()).filter((l) => /^[-•]/.test(l)).slice(0, 5).join('\n');
      if (clean && !CJK.test(clean)) lines.push('', say(language, 'Top topics:', 'أكتر المواضيع:'), clean);
    } catch (err) {
      console.warn('[report] Topics failed:', err.message);
    }
  }
  if (quiet.length) {
    lines.push('', say(language, 'Asked about prices and went quiet:', 'سألوا عن أسعار وما رجعوا:'));
    quiet.slice(0, 5).forEach((q) => lines.push(`• ${[q.name, q.handle].filter(Boolean).join(' · ')}: «${q.asked}»`));
  }
  return lines.join('\n');
}

// --- Customer memory: short notes per customer, kept up to date as they chat ---
const PROFILE_AFTER = 3; // new customer messages before the notes are updated

export function profilesToUpdate({ now = new Date(), skip = new Set(), limit = 3 } = {}) {
  const idleSince = sqlTime(new Date(now.getTime() - 10 * 60e3));
  return db.prepare(
    `SELECT c.id, c.meta FROM conversations c
     WHERE c.last_message_at <= ? AND c.last_message_at >= ?
     ORDER BY c.last_message_at DESC LIMIT 200`,
  ).all(idleSince, sqlTime(new Date(now.getTime() - 14 * 86400e3)))
    .filter((c) => !skip.has(c.id))
    .filter((c) => {
      const meta = JSON.parse(c.meta || '{}');
      const fresh = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND direction = 'in' AND id > ?").get(c.id, meta.profileUpTo || 0).n;
      return fresh >= (meta.profile ? PROFILE_AFTER : 2);
    })
    .slice(0, limit)
    .map((c) => c.id);
}

export async function buildProfile(conversationId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  const meta = JSON.parse(conv.meta || '{}');
  const rows = db.prepare("SELECT id, direction, text FROM messages WHERE conversation_id = ? AND direction IN ('in', 'out') ORDER BY id DESC LIMIT 30").all(conversationId).reverse();
  if (!rows.length) return null;
  const chatText = rows.map((m) => `${m.direction === 'in' ? 'Customer' : 'Us'}: ${withoutPhoto(m.text).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const out = await chat([
    { role: 'system', content: [
      `You keep short notes about a customer of ${getSetting('company_name')}, so the next chat can be more personal.`,
      meta.profile ? `Current notes:\n${meta.profile}` : 'There are no notes yet.',
      'Update the notes from the chat below. At most 5 lines, each starting with "- ". Only facts the customer said or that were agreed: their name, city, what they want or bought, budget, preferences, language, anything we promised them.',
      'No guesses, no opinions about the customer, no payment card or ID numbers. Keep it in English. If there is nothing worth noting, answer "- (nothing yet)". Never Chinese.',
    ].join('\n') },
    { role: 'user', content: chatText },
  ], { temperature: 0 });
  const notes = out.split('\n').map((l) => l.trim()).filter((l) => /^- /.test(l)).slice(0, 5).join('\n');
  if (!notes || CJK.test(notes)) return null;
  return { profile: notes === '- (nothing yet)' ? '' : notes, upTo: rows.filter((m) => m.direction === 'in').at(-1)?.id || 0 };
}
