// Small timezone helpers, so "tomorrow at 9" means 9:00 where the owner lives, not in the server's
// timezone (Docker runs in UTC).

function parts(date, timeZone) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

// Minutes the zone is ahead of UTC at that moment.
function offsetMinutes(date, timeZone) {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "2026-11-11 09:00" (local to timeZone) -> Date, or null when it doesn't parse.
export function fromLocal(text, timeZone) {
  const m = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  utc = guess - offsetMinutes(new Date(utc), timeZone) * 60000; // right side of a DST change
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Date -> "2026-11-11 09:00" in timeZone.
export function toLocal(date, timeZone) {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// What the model needs to know to turn "tomorrow" into a date.
export function nowContext(now, timeZone) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  return `${weekday} ${toLocal(now, timeZone)}`;
}

// A friendly date for messages: "Wed 11 Nov, 09:00" / "الأربعاء 11 نوفمبر، 09:00".
export function pretty(date, timeZone, language = 'English') {
  const locale = language === 'Arabic' ? 'ar-SY-u-nu-latn' : 'en-GB';
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return language === 'Arabic' ? `${day}، ${time}` : `${day}, ${time}`;
}

// Start and end (as Dates) of the local day that contains `date`.
export function localDayBounds(date, timeZone) {
  const day = toLocal(date, timeZone).slice(0, 10);
  const start = fromLocal(`${day} 00:00`, timeZone);
  const next = new Date(start.getTime() + 36 * 3600e3);
  return { start, end: fromLocal(`${toLocal(next, timeZone).slice(0, 10)} 00:00`, timeZone) };
}
