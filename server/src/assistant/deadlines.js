// Dates the owner wants to keep track of: domains, licences, subscriptions, contracts.
// "احفظ تواريخ الدومينات وذكرني قبل ما تنتهي" (often with a screenshot) saves each one and sets
// reminders before it; "ايمت بينتهي example.com؟" answers from what was saved.
import { db } from '../db.js';
import { chat } from '../ai/ollama.js';

export const TRACK_WORDS = /(ذكرني|ذكّرني|ذكرنى|فكرني|نبهني|نبّهني|remind|alert me|notify me)[\s\S]*(انتهاء|ينتهي|بينتهي|تنتهي|بتنتهي|خلص|تجديد|يتجدد|expir|renew|deadline|due)|(انتهاء|expir|renew|تجديد)[\s\S]*(ذكرني|ذكّرني|نبهني|remind)|(احفظ|خزن|سجل|save|track)[\s\S]*(تواريخ|التواريخ|dates|deadlines|domains|الدومينات|دومينات)/i;
export const ASK_WORDS = /(ايمت|إيمت|امتى|إمتى|متى|اي\s?وقت|when|which|شو|أي|اي|قديش|كم)[\s\S]*(بينتهي|ينتهي|تنتهي|بتنتهي|انتهاء|بيخلص|بتخلص|expire|expiring|expiry|renew|تجديد|قرب|قربت|due)/i;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "2027-01-10", "10/01/2027", "10-1-2027", "Jan 10, 2027", "10 January 2027" → "2027-01-10".
export function parseDate(text) {
  const t = String(text || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  let m = t.match(/\b(20\d\d)[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d\d)\b/);
  if (m) return +m[2] > 12 ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  m = t.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d\d)\b/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = t.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(20\d\d)\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// A row often has both the registration and the expiry date: the expiry is the later one.
function latestDate(line) {
  const dates = String(line).split(/\s{2,}|\t|,(?=\s*\d)|\s(?=\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/).map(parseDate).filter(Boolean);
  return dates.sort().at(-1) || parseDate(line);
}

const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})\b/gi;

// The items and their dates, taken only from what the owner wrote or the photo shows.
export async function extractDeadlines(source) {
  const text = String(source || '');
  const found = new Map();
  // Domains with a date on the same line: no model needed.
  for (const line of text.split(/\n|;|\|/)) {
    const date = latestDate(line);
    const names = (line.match(DOMAIN) || []).filter((n) => !/^\d+(\.\d+)+$/.test(n));
    if (date && names.length === 1) found.set(names[0].toLowerCase(), date);
  }
  if (found.size) return [...found].map(([name, date]) => ({ name, date }));
  // Otherwise the model pairs them up, and only pairs that are really in the text are kept.
  let items = [];
  try {
    const raw = await chat([
      { role: 'system', content: 'List every item (domain, licence, subscription, contract…) and its expiry or due date found in the text. Use the exact names and dates written there; never invent any. Dates as YYYY-MM-DD. JSON only.' },
      { role: 'user', content: text },
    ], { temperature: 0, format: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, date: { type: 'string' } }, required: ['name', 'date'] } } }, required: ['items'] } });
    items = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).items || [];
  } catch { items = []; }
  const lower = text.toLowerCase();
  const digits = text.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
  return items
    .map((i) => ({ name: String(i.name || '').trim(), date: parseDate(i.date) }))
    .filter((i) => i.name && i.date && lower.includes(i.name.toLowerCase()) && digits.includes(i.date.slice(0, 4)))
    .filter((i, n, all) => all.findIndex((x) => x.name.toLowerCase() === i.name.toLowerCase()) === n);
}

// "قبل شهر" / "قبل اسبوع" / "10 days before": how long before each date to remind. Default: 30, 7 and 1 days.
export function leadDays(said) {
  const t = String(said || '');
  const out = new Set();
  for (const m of t.matchAll(/(\d{1,3})\s*(يوم|ايام|أيام|days?)/gi)) out.add(+m[1]);
  if (/(قبل\s+شهر|a month|one month|شهر)/i.test(t)) out.add(30);
  if (/(قبل\s+(اسبوع|أسبوع|جمعة)|a week|one week)/i.test(t)) out.add(7);
  if (/(قبل\s+يومين|two days)/i.test(t)) out.add(2);
  if (/(قبل\s+(بيوم|يوم)|a day before|one day)/i.test(t)) out.add(1);
  const list = [...out].filter((n) => n > 0 && n <= 365).sort((a, b) => b - a);
  return list.length ? list : [30, 7, 1];
}

export const daysLeft = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400e3);

export function listDeadlines(key) {
  return db.prepare('SELECT * FROM deadlines WHERE owner_key = ? ORDER BY due_date').all(key);
}

// Save (or update) each item. Returns the rows, so reminders can be set for them.
export function saveDeadlines(key, items) {
  const rows = [];
  for (const i of items) {
    const old = db.prepare('SELECT * FROM deadlines WHERE owner_key = ? AND lower(name) = lower(?)').get(key, i.name);
    if (old) {
      db.prepare('UPDATE deadlines SET due_date = ? WHERE id = ?').run(i.date, old.id);
      // The old date's reminders no longer apply.
      db.prepare("DELETE FROM tasks WHERE status = 'pending' AND kind = 'reminder' AND json_extract(payload, '$.deadlineId') = ?").run(old.id);
      rows.push({ ...old, due_date: i.date });
    } else {
      const id = db.prepare('INSERT INTO deadlines (owner_key, name, due_date) VALUES (?, ?, ?)').run(key, i.name, i.date).lastInsertRowid;
      rows.push({ id, name: i.name, due_date: i.date });
    }
  }
  return rows;
}

// The saved items the owner's words name ("example" finds "example.com").
export function namedDeadlines(key, said) {
  const t = String(said || '').toLowerCase();
  return listDeadlines(key).filter((d) => {
    const n = d.name.toLowerCase();
    return t.includes(n) || (n.split('.')[0].length >= 3 && new RegExp(`(^|[^a-z0-9])${n.split('.')[0].replace(/[-]/g, '\\-')}([^a-z0-9]|$)`).test(t));
  });
}
