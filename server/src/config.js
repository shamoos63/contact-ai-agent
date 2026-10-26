import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// A stable secret for signing login sessions. Generated once and kept in the data folder
// unless JWT_SECRET is set.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, '.jwt-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: loadSecret(),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  chatModel: process.env.CHAT_MODEL || 'qwen2.5:7b',
  embedModel: process.env.EMBED_MODEL || 'bge-m3',
  clientDir: path.resolve(process.env.CLIENT_DIR || '../client/dist'),
};
