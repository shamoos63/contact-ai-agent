import { getSetting } from '../settings.js';
import { emit } from '../realtime.js';

function baseUrl() {
  return getSetting('ollama_url').replace(/\/+$/, '');
}

async function call(path, body, { timeoutMs = 300000 } = {}) {
  const res = await fetch(baseUrl() + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Ollama handles one generation at a time well on a laptop, so requests are queued.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Keep models in memory between messages. Ollama unloads them after 5 idle minutes by default,
// and reloading several GB from disk is what makes the first reply after a pause so slow.
const keepAlive = () => getSetting('keep_alive') || '24h';

// Timing of recent replies, so the dashboard can show where the time goes.
const timings = [];
const ms = (ns) => Math.round((ns || 0) / 1e6);

export function chat(messages, { temperature } = {}) {
  return enqueue(async () => {
    const started = Date.now();
    const data = await call('/api/chat', {
      model: getSetting('chat_model'),
      messages,
      stream: false,
      keep_alive: keepAlive(),
      options: { temperature: temperature ?? getSetting('temperature'), num_ctx: Number(getSetting('context_size')) || 4096 },
    });
    const t = {
      at: Date.now(),
      totalMs: Date.now() - started,
      loadMs: ms(data.load_duration),
      promptTokens: data.prompt_eval_count || 0,
      promptMs: ms(data.prompt_eval_duration),
      outputTokens: data.eval_count || 0,
      outputMs: ms(data.eval_duration),
    };
    t.tokensPerSecond = t.outputMs ? +(t.outputTokens / (t.outputMs / 1000)).toFixed(1) : 0;
    timings.unshift(t);
    timings.length = Math.min(timings.length, 20);
    console.log(`[ollama] Reply in ${(t.totalMs / 1000).toFixed(1)}s (load ${(t.loadMs / 1000).toFixed(1)}s, ` +
      `read ${t.promptTokens} tokens in ${(t.promptMs / 1000).toFixed(1)}s, wrote ${t.outputTokens} tokens at ${t.tokensPerSecond}/s)`);
    emit('ai-timing', t);
    return data.message?.content?.trim() || '';
  });
}

export async function embed(texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const out = [];
  // Batch to keep requests a sensible size.
  for (let i = 0; i < input.length; i += 16) {
    const data = await call('/api/embed', { model: getSetting('embed_model'), input: input.slice(i, i + 16), keep_alive: keepAlive() });
    out.push(...data.embeddings);
  }
  return out;
}

// Load both models into memory now, so the first customer doesn't wait for it.
export async function warmUp() {
  const started = Date.now();
  try {
    await Promise.all([
      call('/api/chat', { model: getSetting('chat_model'), messages: [], keep_alive: keepAlive() }),
      call('/api/embed', { model: getSetting('embed_model'), input: ['warm up'], keep_alive: keepAlive() }),
    ]);
    console.log(`[ollama] Models loaded into memory in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.warn('[ollama] Warm-up failed:', err.message);
  }
}

// Which models are loaded right now, and how much of each sits on the graphics card.
async function loaded() {
  try {
    const ps = await call('/api/ps', null, { timeoutMs: 5000 });
    return (ps.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      vram: m.size_vram || 0,
      gpuPercent: m.size ? Math.round(((m.size_vram || 0) / m.size) * 100) : 0,
      expires_at: m.expires_at,
    }));
  } catch {
    return [];
  }
}

// Suggested models with their approximate download sizes, shown before a download starts.
export const CATALOG = [
  { name: 'qwen2.5:7b', kind: 'chat', size: 4.7e9, note: 'Recommended. Good Arabic + English, runs on most laptops (8 GB+ RAM).' },
  { name: 'qwen2.5:3b', kind: 'chat', size: 1.9e9, note: 'Smaller and faster, weaker answers. For low-memory machines.' },
  { name: 'qwen2.5:14b', kind: 'chat', size: 9.0e9, note: 'Better answers, needs a strong GPU or 16 GB+ RAM.' },
  { name: 'aya-expanse:8b', kind: 'chat', size: 5.1e9, note: 'Strong in Arabic and other languages.' },
  { name: 'llama3.1:8b', kind: 'chat', size: 4.9e9, note: 'Good English, average Arabic.' },
  { name: 'bge-m3', kind: 'embed', size: 1.2e9, note: 'Recommended. Multilingual search for the knowledge base.' },
  { name: 'nomic-embed-text', kind: 'embed', size: 0.27e9, note: 'Small and fast, English only.' },
];

const sameModel = (a, b) => a === b || a === `${b}:latest` || b === `${a}:latest`;

export async function status() {
  const base = { downloads: downloadList(), catalog: CATALOG, modelsPath: modelsPath(), timings };
  try {
    const tags = await call('/api/tags', null, { timeoutMs: 5000 });
    const installed = (tags.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
      parameters: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      family: m.details?.family,
    }));
    const has = (model) => installed.some((m) => sameModel(m.name, model));
    return {
      ...base,
      online: true,
      loaded: await loaded(),
      timings,
      installed,
      models: installed.map((m) => m.name),
      chatModelReady: has(getSetting('chat_model')),
      embedModelReady: has(getSetting('embed_model')),
    };
  } catch (err) {
    return { ...base, online: false, error: err.message, installed: [], models: [] };
  }
}

// Where Ollama keeps its model files on the host. Docker can't see the host path, so it is
// passed in by docker-compose; otherwise use Ollama's default for this machine.
function modelsPath() {
  if (process.env.OLLAMA_MODELS_PATH) return process.env.OLLAMA_MODELS_PATH;
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  if (process.platform === 'win32') return '%USERPROFILE%\\.ollama\\models';
  if (process.platform === 'linux') return '~/.ollama/models (or /usr/share/ollama/.ollama/models when Ollama runs as a service)';
  return '~/.ollama/models';
}

// --- Downloads with live progress ---
const downloads = new Map(); // model -> progress record

function downloadList() {
  return [...downloads.values()].map(({ abort, layers, ...d }) => d);
}

function publish(force = false) {
  const now = Date.now();
  if (!force && now - lastPublish < 500) return;
  lastPublish = now;
  emit('model-downloads', downloadList());
}
let lastPublish = 0;

export function cancelPull(model) {
  downloads.get(model)?.abort.abort();
}

export async function pullModel(model) {
  if (downloads.get(model)?.state === 'downloading') return;
  const abort = new AbortController();
  const d = {
    model, state: 'downloading', status: 'starting', total: 0, completed: 0,
    speed: 0, startedAt: Date.now(), finishedAt: null, error: null, abort, layers: new Map(),
  };
  downloads.set(model, d);
  publish(true);
  console.log(`[ollama] Downloading ${model}...`);
  let lastBytes = 0;
  let lastTime = Date.now();
  try {
    const res = await fetch(baseUrl() + '/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama pull failed: ${res.status} ${await res.text()}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        d.status = msg.status;
        if (msg.digest && msg.total) d.layers.set(msg.digest, { total: msg.total, completed: msg.completed || 0 });
        d.total = [...d.layers.values()].reduce((s, l) => s + l.total, 0);
        d.completed = [...d.layers.values()].reduce((s, l) => s + l.completed, 0);
        const now = Date.now();
        if (now - lastTime >= 1000) {
          const rate = ((d.completed - lastBytes) * 1000) / (now - lastTime);
          d.speed = d.speed ? d.speed * 0.7 + rate * 0.3 : rate;
          lastBytes = d.completed;
          lastTime = now;
        }
        publish();
      }
    }
    if (d.status !== 'success') throw new Error('Download ended before it finished');
    Object.assign(d, { state: 'done', completed: d.total, speed: 0, finishedAt: Date.now() });
    console.log(`[ollama] ${model} ready`);
    if ([getSetting('chat_model'), getSetting('embed_model')].includes(model)) warmUp();
  } catch (err) {
    const cancelled = abort.signal.aborted;
    Object.assign(d, { state: cancelled ? 'cancelled' : 'error', error: cancelled ? null : err.message, speed: 0, finishedAt: Date.now() });
    if (!cancelled) console.error(`[ollama] Download of ${model} failed:`, err.message);
  } finally {
    publish(true);
  }
}

export async function deleteModel(model) {
  const res = await fetch(baseUrl() + '/api/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(`Could not delete ${model}: ${await res.text()}`);
  downloads.delete(model);
}

// Download the configured models in the background if they are missing.
export async function ensureModels() {
  const s = await status();
  if (!s.online) {
    console.warn(`[ollama] Not reachable at ${baseUrl()} (${s.error}). Start Ollama to enable AI replies.`);
    return;
  }
  if (!s.chatModelReady) pullModel(getSetting('chat_model'));
  if (!s.embedModelReady) pullModel(getSetting('embed_model'));
  if (s.chatModelReady && s.embedModelReady) warmUp();
}
