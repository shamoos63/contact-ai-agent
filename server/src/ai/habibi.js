import fs from 'node:fs';
import path from 'node:path';

// The owner's Levantine voice, spoken by Habibi from the reference clips in data/voices/habibi.
// A separate process on this Mac holds the model; the dashboard asks it for a wav.

export const HABIBI_VOICE_ID = 'ar-own-habibi';

// A voice note goes out alone. The written reply is added only when this is asked for.
const ASKED_FOR_TEXT = /(اكتبها|اكتبيها|اكتبلي|بالكتابة|بالنص|مع النص|والنص|والكتابة|ابعت النص|ابعث النص|أرسل النص|write it( down)?|as text|in text|text too|the written)/i;

export function askedForText(text) {
  return ASKED_FOR_TEXT.test(String(text || ''));
}

const DIGITS = ['صفر', 'واحد', 'تنين', 'تلاتة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'تمانية', 'تسعة'];

export function habibiUrl() {
  return (process.env.HABIBI_URL || 'http://127.0.0.1:8091').replace(/\/$/, '');
}

// Which recorded delivery to copy. The first match wins, so the more specific lines
// (closed, handoff, apology) come before the general question and greeting checks.
export function pickHabibiStyle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'calm';
  if (/^(هه+|هاها+|ههه+|😂+|lol|haha)[.!؟?\s]*$/i.test(t)) return 'laugh';
  if (/أوقات الدوام|الدوام حالياً|خلصت|مسكّر|مسكرين|مسكّرين/.test(t)) return 'closed';
  if (/حولك|بحولك|رح حول|أحولك|احولك/.test(t)) return 'forward';
  if (/معلش|بعتذر|آسف|اسف|تأخرنا/.test(t)) return 'apology';
  if (/أخبار حلوة|اخبار حلوة|طلبك جاهز|مبروك|تهانينا/.test(t)) return 'happy';
  if (/مواصفات|الاستخدام يلي/.test(t)) return 'details';
  if (/يا هشام|ضبطتلك|تذكير/.test(t)) return 'jarvis';
  if (/رقم الواتساب|رقم الهاتف|رقم التليفون|واتساب تبع/.test(t) || (t.match(/\d/g) || []).length >= 6) return 'numbers';
  if (/[A-Za-z]{2,}/.test(t) && /[\u0600-\u06FF]/.test(t)) return 'mixed';
  if (/سيقوم|يرجى|حضرات|لتواصلكم|أحد المختصين|استفساركم/.test(t)) return 'formal';
  if (/^(مرحبا|مرحباً|أهلا|أهلاً|أهلين|هلا|صباح|مساء)/.test(t)) return 'greeting';
  if (/فاتحين|من السبت|يوم الجمعة|مسكّرين|مسكرين/.test(t)) return 'hours';
  if (/[?؟]\s*$/.test(t)) return 'question';
  return 'calm';
}

// Habibi reads digits as themselves. Phone numbers are already split into single digits
// by speakable(); here each digit becomes the Levantine word said in the recording.
export function prepareHabibiText(text) {
  return String(text || '')
    .replace(/\d/g, (d) => ` ${DIGITS[Number(d)]} `)
    .replace(/؟/g, '?')
    .replace(/،/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function habibiHealth() {
  try {
    const res = await fetch(`${habibiUrl()}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return { ok: false, url: habibiUrl() };
    const body = await res.json();
    return { ok: true, url: habibiUrl(), styles: body.styles || [] };
  } catch {
    return { ok: false, url: habibiUrl() };
  }
}

// Returns a wav buffer. Throws when the voice server is down or rejects the text.
export async function habibiWav(text, { speed = 1, clipsDir } = {}) {
  const style = pickHabibiStyle(text);
  if (style === 'laugh' && clipsDir) {
    const laugh = path.join(clipsDir, 'laugh.wav');
    if (fs.existsSync(laugh)) return fs.readFileSync(laugh);
  }
  const spoken = prepareHabibiText(text);
  if (!spoken) throw new Error('Nothing to say');
  let res;
  try {
    res = await fetch(`${habibiUrl()}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken, style, speed }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    throw new Error(`Your voice server is not running (${err.message}).`);
  }
  if (!res.ok) throw new Error((await res.text()).trim() || `Habibi HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
