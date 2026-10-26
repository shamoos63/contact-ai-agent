import { getSetting } from '../settings.js';

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

export function chat(messages, { temperature } = {}) {
  return enqueue(async () => {
    const data = await call('/api/chat', {
      model: getSetting('chat_model'),
      messages,
      stream: false,
      options: { temperature: temperature ?? getSetting('temperature') },
    });
    return data.message?.content?.trim() || '';
  });
}

export async function embed(texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const out = [];
  // Batch to keep requests a sensible size.
  for (let i = 0; i < input.length; i += 16) {
    const data = await call('/api/embed', { model: getSetting('embed_model'), input: input.slice(i, i + 16) });
    out.push(...data.embeddings);
  }
  return out;
}

export async function status() {
  try {
    const tags = await call('/api/tags', null, { timeoutMs: 5000 });
    const names = (tags.models || []).map((m) => m.name);
    const has = (model) => names.some((n) => n === model || n === `${model}:latest` || n.split(':')[0] === model);
    return {
      online: true,
      models: names,
      chatModelReady: has(getSetting('chat_model')),
      embedModelReady: has(getSetting('embed_model')),
      pulling: [...pulling],
    };
  } catch (err) {
    return { online: false, error: err.message, models: [], pulling: [...pulling] };
  }
}

const pulling = new Set();

export async function pullModel(model) {
  if (pulling.has(model)) return;
  pulling.add(model);
  try {
    console.log(`[ollama] Pulling ${model}... (this can take a while the first time)`);
    await call('/api/pull', { model, stream: false }, { timeoutMs: 6 * 3600 * 1000 });
    console.log(`[ollama] ${model} ready`);
  } finally {
    pulling.delete(model);
  }
}

// Download the configured models in the background if they are missing.
export async function ensureModels() {
  const s = await status();
  if (!s.online) {
    console.warn(`[ollama] Not reachable at ${baseUrl()} (${s.error}). Start Ollama to enable AI replies.`);
    return;
  }
  if (!s.chatModelReady) pullModel(getSetting('chat_model')).catch((e) => console.error('[ollama]', e.message));
  if (!s.embedModelReady) pullModel(getSetting('embed_model')).catch((e) => console.error('[ollama]', e.message));
}
