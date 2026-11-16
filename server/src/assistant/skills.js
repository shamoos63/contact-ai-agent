import { db } from '../db.js';
import { emit } from '../realtime.js';
import { fromLocal, toLocal } from './time.js';

// Abilities taught by chat, without code:
// - rules: extra instructions for customer answers ("always mention free delivery over 500 AED").
// - jobs: an instruction that runs by itself every day or every week, exactly as if the owner had
//   just sent it ("every Friday at 5 send Nour the week's summary"). Sending still asks "yes" first
//   when "show me messages first" is on.

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_AR = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

export function listSkills() {
  return db.prepare('SELECT * FROM skills ORDER BY kind, id').all();
}

export function rulesForCustomers() {
  return db.prepare("SELECT text FROM skills WHERE kind = 'rule' AND enabled = 1 ORDER BY id").all().map((r) => r.text);
}

// The next time a job runs, after `after`.
export function nextRun({ repeat, weekday, time }, tz, after = new Date()) {
  const today = toLocal(after, tz).slice(0, 10);
  for (let n = 0; n <= 8; n++) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3);
    if (repeat === 'weekly' && day.getUTCDay() !== weekday) continue;
    const at = fromLocal(`${day.toISOString().slice(0, 10)} ${time}`, tz);
    if (at && at > after) return at;
  }
  return null;
}

export function addSkill({ kind, text, owner, ownerConversationId, repeat = null, weekday = null, time = null }, tz) {
  const next = kind === 'job' ? nextRun({ repeat, weekday, time }, tz)?.toISOString() : null;
  const info = db.prepare('INSERT INTO skills (kind, text, owner_name, owner_conversation_id, repeat, weekday, time, next_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(kind, text, owner?.name || null, ownerConversationId ?? null, repeat, weekday, time, next);
  emit('skills', { changed: true });
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(info.lastInsertRowid);
}

export function removeSkill(id) {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
  if (s) db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  emit('skills', { changed: true });
  return s;
}

export function setSkillEnabled(id, enabled, tz) {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
  if (!s) return null;
  const next = s.kind === 'job' && enabled ? nextRun(s, tz)?.toISOString() : s.next_run;
  db.prepare('UPDATE skills SET enabled = ?, next_run = ? WHERE id = ?').run(enabled ? 1 : 0, next, id);
  emit('skills', { changed: true });
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
}

// Jobs that are due; each is moved to its next time before it runs, so it never runs twice.
export function takeDueJobs(now, tz) {
  const due = db.prepare("SELECT * FROM skills WHERE kind = 'job' AND enabled = 1 AND next_run IS NOT NULL AND next_run <= ?").all(now.toISOString());
  for (const j of due) {
    db.prepare('UPDATE skills SET next_run = ?, last_run = ? WHERE id = ?').run(nextRun(j, tz, now)?.toISOString() || null, now.toISOString(), j.id);
  }
  if (due.length) emit('skills', { changed: true });
  return due;
}

export function describeSkill(s, language = 'English') {
  if (s.kind === 'rule') return language === 'Arabic' ? `قاعدة: ${s.text}` : `Rule: ${s.text}`;
  const when = s.repeat === 'weekly'
    ? (language === 'Arabic' ? `كل ${DAY_NAMES_AR[s.weekday]} الساعة ${s.time}` : `every ${DAY_NAMES[s.weekday]} at ${s.time}`)
    : (language === 'Arabic' ? `كل يوم الساعة ${s.time}` : `every day at ${s.time}`);
  return `${when}: ${s.text}`;
}
