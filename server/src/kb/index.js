import { db } from '../db.js';
import { embed } from '../ai/ollama.js';
import { chunkText } from './extract.js';
import { emit } from '../realtime.js';

const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);
const fromBlob = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

// In-memory cache of all chunk vectors; rebuilt when the knowledge base changes.
let cache = null;

function loadCache() {
  if (cache) return cache;
  cache = db
    .prepare(
      `SELECT c.id, c.text, c.embedding, s.title, s.id AS source_id FROM kb_chunks c
       JOIN kb_sources s ON s.id = c.source_id WHERE s.status = 'ready' AND c.embedding IS NOT NULL`,
    )
    .all()
    .map((r) => ({ ...r, embedding: normalize(fromBlob(r.embedding)) }));
  return cache;
}

export function invalidateCache() {
  cache = null;
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function createSource({ type, title, origin, content }) {
  const info = db
    .prepare('INSERT INTO kb_sources (type, title, origin, content) VALUES (?, ?, ?, ?)')
    .run(type, title, origin || null, content);
  return info.lastInsertRowid;
}

export async function indexSource(id) {
  const source = db.prepare('SELECT * FROM kb_sources WHERE id = ?').get(id);
  if (!source) return;
  const setStatus = db.prepare('UPDATE kb_sources SET status = ?, error = ?, chunk_count = ? WHERE id = ?');
  try {
    setStatus.run('pending', null, 0, id);
    emit('kb', { id });
    const chunks = chunkText(`${source.title}\n\n${source.content || ''}`);
    if (!chunks.length) throw new Error('No readable text found');
    const vectors = await embed(chunks);
    const insert = db.prepare('INSERT INTO kb_chunks (source_id, idx, text, embedding) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(id);
      chunks.forEach((text, i) => insert.run(id, i, text, toBlob(vectors[i])));
      setStatus.run('ready', null, chunks.length, id);
    })();
  } catch (err) {
    console.error(`[kb] Indexing source ${id} failed:`, err.message);
    setStatus.run('error', err.message, 0, id);
  }
  invalidateCache();
  emit('kb', { id });
}

export async function search(query, { k = 5, minScore = 0.35 } = {}) {
  const items = loadCache();
  if (!items.length) return [];
  const [qv] = await embed([query]);
  const q = normalize(qv);
  return items
    .map((item) => ({ id: item.id, source_id: item.source_id, title: item.title, text: item.text, score: dot(q, item.embedding) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Re-embed everything, e.g. after switching the embedding model.
export async function reindexAll() {
  const ids = db.prepare('SELECT id FROM kb_sources').all().map((r) => r.id);
  for (const id of ids) await indexSource(id);
}
