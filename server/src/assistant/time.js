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

// Day words the model often gets wrong ("الخميس" -> Saturday). Returns { date: 'YYYY-MM-DD', word } for the
// first day word in the text, or null. A weekday means its next occurrence (today if it is today).
const DAY_WORDS = [
  [2, ['after tomorrow', 'بعد بكرا', 'بعد بكره', 'بعد بكرة', 'بعد غد', 'بعد الغد', 'بعد بكير']],
  [1, ['tomorrow', 'بكرا', 'بكره', 'بكرة', 'غدا', 'غدًا', 'غداً', 'الغد', 'باكر']],
  [0, ['today', 'tonight', 'اليوم', 'الليلة', 'هالمسا', 'المسا هاد']],
];
const WEEKDAYS = [
  ['sunday', 'الأحد', 'الاحد', 'الحد'],
  ['monday', 'الاثنين', 'الإثنين', 'الاتنين', 'التنين'],
  ['tuesday', 'الثلاثاء', 'الثلاثا', 'التلاتا', 'التلاتاء'],
  ['wednesday', 'الأربعاء', 'الاربعاء', 'الاربعا', 'الأربعا'],
  ['thursday', 'الخميس'],
  ['friday', 'الجمعة', 'الجمعه'],
  ['saturday', 'السبت'],
];

export function dayFromWords(text, now, timeZone) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const today = toLocal(now, timeZone).slice(0, 10);
  const plusDays = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
  let best = null;
  const consider = (index, date, word) => {
    if (index >= 0 && (!best || index < best.index)) best = { index, date, word };
  };
  for (const [n, words] of DAY_WORDS) {
    for (const w of words) {
      const i = t.indexOf(w);
      // "بعد بكرا" also contains "بكرا": the longer phrase wins because it starts earlier.
      if (i >= 0 && !(best && best.index <= i)) consider(i, plusDays(n), w);
    }
  }
  const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
  WEEKDAYS.forEach((names, dow) => {
    for (const w of names) {
      const re = new RegExp(`(^|[^\\p{L}])${w}(?=$|[^\\p{L}])`, 'u');
      const m = t.match(re);
      if (m) consider(m.index + m[1].length, plusDays((dow - todayDow + 7) % 7), w);
    }
  });
  return best && { date: best.date, word: best.word };
}
