import { db } from './db.js';
import { config } from './config.js';

const DEFAULTS = {
  company_name: 'Our Company',
  ollama_url: config.ollamaUrl,
  chat_model: config.chatModel,
  embed_model: config.embedModel,
  system_prompt:
    'You are a friendly, professional customer support assistant for {company}. ' +
    'Answer only using the company knowledge provided. Keep answers short and clear, suitable for chat.',
  fallback_message:
    'I am not sure about that. A member of our team will get back to you soon.',
  auto_reply: true,
  reply_delay_seconds: 4,
  temperature: 0.3,
  keep_alive: '24h',
  context_size: 4096,
  telegram: { enabled: false, token: '' },
  whatsapp: { enabled: false },
  meta: {
    enabled: false,
    verify_token: '',
    app_secret: '',
    page_id: '',
    page_token: '',
    instagram_enabled: false,
    graph_version: 'v21.0',
  },
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getSetting(key) {
  const row = getStmt.get(key);
  const def = DEFAULTS[key];
  if (!row) return def;
  const value = JSON.parse(row.value);
  if (def && typeof def === 'object' && !Array.isArray(def)) return { ...def, ...value };
  return value;
}

export function setSetting(key, value) {
  setStmt.run(key, JSON.stringify(value));
}

export function getAllSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = getSetting(key);
  return out;
}

export const SETTING_KEYS = Object.keys(DEFAULTS);
