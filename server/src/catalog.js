import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db } from './db.js';
import { getSetting } from './settings.js';
import { createSource, indexSource, invalidateCache } from './kb/index.js';
import { saveMedia, MEDIA_DIR } from './voice.js';
import { emit } from './realtime.js';

// The product catalog: name, price, description, photo and stock. Each product is also a Knowledge
// source ("🛍️ name"), so the AI answers from it like from any other knowledge, and when its answer
// is about a product, the product's photo is sent with it.

export const PRODUCT_ICON = '🛍️';

export function listProducts() {
  return db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
}

const sourceText = (p) => [
  `Product: ${p.name}`,
  p.price ? `Price: ${p.price}` : null,
  `Available: ${p.in_stock ? 'yes, in stock' : 'no, out of stock at the moment'}`,
  p.description ? `\n${p.description}` : null,
].filter(Boolean).join('\n');

// A photo from the dashboard: rotated upright, at most 1280 px, as JPEG.
export async function saveProductImage(buffer) {
  const jpg = await sharp(buffer, { failOn: 'none' }).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return saveMedia(jpg, 'jpg');
}

export async function saveProduct({ id, name, price, description, in_stock, image }) {
  name = String(name || '').trim().slice(0, 120);
  if (!name) throw new Error('The product needs a name');
  const fields = { name, price: String(price ?? '').trim().slice(0, 60) || null, description: String(description ?? '').trim().slice(0, 4000) || null, in_stock: in_stock === false || in_stock === 0 || in_stock === '0' || in_stock === 'false' ? 0 : 1 };
  let p = id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
  if (id && !p) throw new Error('Product not found');
  if (p) {
    if (image && p.image && p.image !== image) fs.rmSync(path.join(MEDIA_DIR, p.image), { force: true });
    db.prepare("UPDATE products SET name = ?, price = ?, description = ?, in_stock = ?, image = COALESCE(?, image), updated_at = datetime('now') WHERE id = ?")
      .run(fields.name, fields.price, fields.description, fields.in_stock, image || null, id);
  } else {
    id = db.prepare('INSERT INTO products (name, price, description, in_stock, image) VALUES (?, ?, ?, ?, ?)').run(fields.name, fields.price, fields.description, fields.in_stock, image || null).lastInsertRowid;
  }
  p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  // Its Knowledge source, kept in step.
  const title = `${PRODUCT_ICON} ${p.name}`;
  let sourceId = p.source_id && db.prepare('SELECT id FROM kb_sources WHERE id = ?').get(p.source_id)?.id;
  if (sourceId) db.prepare('UPDATE kb_sources SET title = ?, content = ? WHERE id = ?').run(title, sourceText(p), sourceId);
  else {
    sourceId = createSource({ type: 'text', title, origin: null, content: sourceText(p) });
    db.prepare('UPDATE products SET source_id = ? WHERE id = ?').run(sourceId, id);
  }
  await indexSource(sourceId);
  emit('products', { id });
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

export function deleteProduct(id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return false;
  if (p.source_id) db.prepare('DELETE FROM kb_sources WHERE id = ?').run(p.source_id);
  if (p.image) fs.rmSync(path.join(MEDIA_DIR, p.image), { force: true });
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  invalidateCache();
  emit('products', { id });
  return true;
}

const simple = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Products to show with a reply: found in the knowledge used for it, named in the reply, with a
// photo, and not already shown in this chat today. At most two.
export function productPhotosFor(conversationId, reply, sourceIds = []) {
  if (getSetting('catalog').send_photos === false || !sourceIds.length) return [];
  const said = ` ${simple(reply)} `;
  const out = [];
  for (const sid of [...new Set(sourceIds)]) {
    const p = db.prepare('SELECT * FROM products WHERE source_id = ? AND image IS NOT NULL').get(sid);
    if (!p || !said.includes(` ${simple(p.name)} `)) continue;
    const shown = db.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'out' AND created_at >= datetime('now', '-1 day') AND meta LIKE ?`)
      .get(conversationId, `%"product":${p.id}%`);
    if (shown || !fs.existsSync(path.join(MEDIA_DIR, p.image))) continue;
    out.push(p);
    if (out.length >= 2) break;
  }
  return out;
}
