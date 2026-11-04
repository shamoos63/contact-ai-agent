import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { getSetting } from '../settings.js';
import { emit } from '../realtime.js';

// Speech-to-text for voice notes, fully local: OpenAI's Whisper model run by transformers.js.
// The model is downloaded once from Hugging Face into data/speech-models.

export const SPEECH_MODELS_DIR = path.join(DATA_DIR, 'speech-models');

export const SPEECH_MODELS = [
  { id: 'onnx-community/whisper-base', label: 'Base', size: 0.2e9, note: 'Fast, OK for clear English, weak Arabic.' },
  { id: 'onnx-community/whisper-small', label: 'Small', size: 0.6e9, note: 'Recommended. Good Arabic and English on a normal laptop.' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Large v3 turbo', size: 1.6e9, note: 'Best Arabic, needs a strong machine. Slower on CPU.' },
];

const LANGUAGES = { auto: null, arabic: 'arabic', english: 'english' };

let pipe = null; // { model, promise }
let state = { status: 'idle', model: null, progress: null, error: null };

export function speechStatus() {
  return { ...state, models: SPEECH_MODELS, modelsPath: SPEECH_MODELS_DIR, settings: getSetting('voice') };
}

function setState(patch) {
  state = { ...state, ...patch };
  emit('speech', speechStatus());
}

// Load (and on first use download) the configured Whisper model.
export function loadModel() {
  const model = getSetting('voice').model;
  if (pipe?.model === model) return pipe.promise;
  const files = new Map();
  const promise = (async () => {
    setState({ status: 'loading', model, progress: null, error: null });
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = SPEECH_MODELS_DIR;
    const asr = await pipeline('automatic-speech-recognition', model, {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, { loaded: p.loaded, total: p.total });
        const all = [...files.values()];
        setState({ progress: { loaded: all.reduce((s, f) => s + f.loaded, 0), total: all.reduce((s, f) => s + f.total, 0) } });
      },
    });
    setState({ status: 'ready', progress: null });
    console.log(`[speech] ${model} ready`);
    return asr;
  })();
  pipe = { model, promise };
  promise.catch((err) => {
    if (pipe?.promise === promise) pipe = null;
    const offline = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err.message);
    setState({ status: 'error', error: offline ? `Could not download the speech model from huggingface.co (${err.message}). Check the internet connection.` : err.message });
    console.error('[speech] Could not load model:', err.message);
  });
  return promise;
}

// Decode any audio (WhatsApp/Telegram send Ogg Opus) to 16 kHz mono float samples with ffmpeg.
export function decodeAudio(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '600', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const chunks = [];
    let errText = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (errText += c));
    ff.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? 'ffmpeg is not installed' : err.message)));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Could not read the audio: ${errText.trim() || 'ffmpeg exit ' + code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
  });
}

// Voice notes are transcribed one at a time so they don't fight the chat model for the CPU.
let queue = Promise.resolve();

export function transcribe(buffer) {
  const run = queue.then(async () => {
    const started = Date.now();
    const audio = await decodeAudio(buffer);
    const asr = await loadModel();
    const language = LANGUAGES[getSetting('voice').language] ?? null;
    const out = await asr(audio, { task: 'transcribe', language, chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
    const ms = Date.now() - started;
    console.log(`[speech] Transcribed ${(audio.length / 16000).toFixed(1)}s of audio in ${(ms / 1000).toFixed(1)}s`);
    return { text, ms, seconds: audio.length / 16000 };
  });
  queue = run.catch(() => {});
  return run;
}

// Test hook: replace the model with a fake one.
export function _setPipelineForTests(fn) {
  pipe = { model: getSetting('voice').model, promise: Promise.resolve(fn) };
  setState({ status: 'ready', model: pipe.model });
}
