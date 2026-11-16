import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { getSetting } from '../settings.js';
import { emit } from '../realtime.js';

// Text-to-speech, fully local: Piper (https://github.com/rhasspy/piper) turns text into speech on
// this computer, ffmpeg turns that into an Ogg Opus voice note like the ones WhatsApp sends.
// Voices are downloaded once from Hugging Face into data/voices.

export const VOICES_DIR = path.join(DATA_DIR, 'voices');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const piperBin = () => process.env.PIPER_BIN || '/opt/piper/piper';

export const VOICES = [
  { id: 'en_GB-alan-medium', language: 'English', label: 'Alan: British man, calm (Jarvis-like)', path: 'en/en_GB/alan/medium', size: 63e6 },
  { id: 'en_GB-northern_english_male-medium', language: 'English', label: 'Northern English man', path: 'en/en_GB/northern_english_male/medium', size: 63e6 },
  { id: 'en_US-ryan-high', language: 'English', label: 'Ryan: American man, clear', path: 'en/en_US/ryan/high', size: 121e6 },
  { id: 'en_US-lessac-medium', language: 'English', label: 'Lessac: American woman', path: 'en/en_US/lessac/medium', size: 63e6 },
  { id: 'ar_JO-kareem-medium', language: 'Arabic', label: 'Kareem: Arabic man (formal Arabic)', path: 'ar/ar_JO/kareem/medium', size: 63e6 },
  { id: 'ar_JO-kareem-low', language: 'Arabic', label: 'Kareem (smaller, faster)', path: 'ar/ar_JO/kareem/low', size: 63e6 },
];

const files = (id) => ({ model: path.join(VOICES_DIR, `${id}.onnx`), config: path.join(VOICES_DIR, `${id}.onnx.json`) });
export const voiceInstalled = (id) => fs.existsSync(files(id).model) && fs.existsSync(files(id).config);
export const piperAvailable = () => fs.existsSync(piperBin());

const downloads = new Map(); // id -> { loaded, total, error }

export function speakStatus() {
  return {
    piper: piperAvailable(),
    settings: getSetting('speak'),
    voices: VOICES.map((v) => ({ ...v, installed: voiceInstalled(v.id), download: downloads.get(v.id) || null })),
    voicesPath: VOICES_DIR,
  };
}
const publish = () => emit('speak', speakStatus());

async function fetchTo(url, dest, onBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60e3) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${path.basename(dest)}`);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onBytes(chunk.length, Number(res.headers.get('content-length')) || 0);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.renameSync(tmp, dest);
}

// Download a voice (once). Retries a few times: big downloads on slow connections sometimes drop.
export function downloadVoice(id) {
  const voice = VOICES.find((v) => v.id === id);
  if (!voice) return Promise.reject(new Error(`Unknown voice ${id}`));
  if (voiceInstalled(id)) return Promise.resolve();
  if (downloads.get(id)?.promise) return downloads.get(id).promise;
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const d = { loaded: 0, total: voice.size, error: null };
  downloads.set(id, d);
  let last = 0;
  d.promise = (async () => {
    const f = files(id);
    for (let attempt = 1; ; attempt++) {
      try {
        d.loaded = 0;
        await fetchTo(`${HF}/${voice.path}/${id}.onnx.json`, f.config, () => {});
        await fetchTo(`${HF}/${voice.path}/${id}.onnx`, f.model, (n, total) => {
          d.loaded += n;
          if (total) d.total = total;
          if (Date.now() - last > 500) { last = Date.now(); publish(); }
        });
        downloads.delete(id);
        console.log(`[voice] ${id} downloaded`);
        return;
      } catch (err) {
        if (attempt >= 4) {
          d.error = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted/i.test(err.message)
            ? `Could not download the voice from huggingface.co (${err.message}). Check the internet connection.` : err.message;
          delete d.promise;
          throw err;
        }
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
  })().finally(publish);
  d.promise.catch((err) => console.error(`[voice] Download of ${id} failed:`, err.message));
  publish();
  return d.promise;
}

// Make text sound right when read aloud: no emoji or Markdown, links are mentioned instead of
// spelled out, and phone numbers are read digit by digit.
export function speakable(text, language = 'English') {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, language === 'Arabic' ? 'الرابط بالرسالة' : 'the link in the message')
    .replace(/[^\s<>"'،,]+@[^\s<>"'،,]+\.[a-z]{2,}/gi, language === 'Arabic' ? 'الإيميل بالرسالة' : 'the email in the message')
    .replace(/\+?\d[\d\s-]{6,}\d/g, (m) => m.replace(/\D/g, '').split('').join(' '))
    .replace(/#(\d+)/g, language === 'Arabic' ? 'رقم $1' : 'number $1')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[*_`#>|[\]{}]/g, ' ')
    .replace(/^\s*[-•·]\s*/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/(\.\s*){2,}/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const textLanguage = (text) => {
  const ar = (String(text).match(/[؀-ۿ]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar > en ? 'Arabic' : 'English';
};

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: path.dirname(cmd) });
    const out = [];
    let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${path.basename(cmd)} failed: ${err.trim().split('\n').pop() || 'exit ' + code}`))));
    if (input !== undefined) p.stdin.end(input);
  });
}

// One voice note at a time, so speaking doesn't fight the chat model for the CPU.
let queue = Promise.resolve();

// Text -> Ogg Opus voice note (Buffer). Throws when speech isn't set up.
export function speak(text, { language } = {}) {
  const job = queue.then(async () => {
    const s = getSetting('speak');
    const lang = language || textLanguage(text);
    const id = lang === 'Arabic' ? s.voice_ar : s.voice_en;
    if (!piperAvailable()) throw new Error('The speech engine (Piper) is not installed. Rebuild the Docker image.');
    if (!voiceInstalled(id)) {
      downloadVoice(id).catch(() => {});
      throw new Error(`The voice ${id} is still downloading`);
    }
    const said = speakable(text, lang).slice(0, 1200);
    if (!said) throw new Error('Nothing to say');
    const wav = path.join(os.tmpdir(), `tts-${crypto.randomBytes(6).toString('hex')}.wav`);
    const started = Date.now();
    try {
      const speed = Math.min(1.6, Math.max(0.6, Number(s.speed) || 1));
      await run(piperBin(), ['--model', files(id).model, '--output_file', wav, '--length_scale', String(+(1 / speed).toFixed(2))], said + '\n');
      const ogg = await run('ffmpeg', ['-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
      console.log(`[voice] Spoke ${said.length} characters with ${id} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return ogg;
    } finally {
      fs.rmSync(wav, { force: true });
    }
  });
  queue = job.catch(() => {});
  return job;
}

export function saveVoiceNote(buffer) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-reply.ogg`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
  return file;
}

// Download the chosen voices in the background when speaking is turned on.
export function ensureVoices() {
  const s = getSetting('speak');
  if (!s.enabled) return;
  for (const id of [s.voice_en, s.voice_ar]) if (id && !voiceInstalled(id)) downloadVoice(id).catch(() => {});
}
