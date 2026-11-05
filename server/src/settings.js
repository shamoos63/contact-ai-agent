import { db } from './db.js';
import { config } from './config.js';

export const DEFAULTS = {
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
  voice: { enabled: true, model: 'onnx-community/whisper-small', language: 'auto' },
  // Team handoff: requests the AI passes to a person, grouped by topic (sales, maintenance, ...).
  handoff: {
    enabled: false,
    brief_language: 'English',
    cooldown_hours: 24,
    // Sent to the customer after they answer the AI's question; the details then go to the team.
    confirm_message_en: 'Thank you! A specialist from our team will contact you soon.',
    confirm_message_ar: 'شكراً لك! سيتواصل معك أحد المختصين من فريقنا قريباً.',
    categories: [
      {
        id: 'sales',
        name: 'Sales',
        enabled: true,
        when: 'the customer wants to buy, asks for prices or a quote, or asks for more sales details',
        ask: 'which product or service, how many, budget, delivery city',
        keywords: 'buy, purchase, price, quote, how much, اشتري, أشتري, شراء, سعر, اسعار, أسعار, بكم, عرض سعر, مستعمل',
        team: [],
      },
      {
        id: 'maintenance',
        name: 'Maintenance request',
        enabled: true,
        when: 'the customer needs a repair, maintenance or a technician visit',
        ask: 'which device or product, what the problem is, their location',
        keywords: 'repair, broken, fix, maintenance, technician, صيانة, تصليح, صلح, خربان, معطل, عطل, فني',
        team: [],
      },
      {
        id: 'software',
        name: 'Software inquiry',
        enabled: true,
        when: 'the customer asks about software, licences, installation or a custom software project',
        ask: 'which software or what they want built, how many users, their deadline',
        keywords: 'software, license, licence, install, برنامج, برامج, تنصيب, تثبيت, ترخيص, نظام',
        team: [],
      },
    ],
  },
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
  if (!row && key === 'handoff') return withDefaultKeywords(legacyHandoff() || DEFAULTS.handoff);
  const def = DEFAULTS[key];
  if (!row) return def;
  const value = JSON.parse(row.value);
  if (key === 'handoff') return withDefaultKeywords({ ...def, ...value });
  if (def && typeof def === 'object' && !Array.isArray(def)) return { ...def, ...value };
  return value;
}

// Topics saved before keywords existed get the built-in keywords for their id.
// The first Sales keywords had "بدي جهاز" ("I want a device"), which also matched repair requests.
const OLD_SALES_KEYWORDS = 'buy, purchase, price, quote, how much, اشتري, أشتري, شراء, سعر, اسعار, أسعار, بكم, عرض سعر, بدي جهاز';
function withDefaultKeywords(h) {
  const builtIn = (id) => DEFAULTS.handoff.categories.find((d) => d.id === id)?.keywords || '';
  const categories = (h.categories || []).map((c) =>
    c.keywords === undefined || (c.id === 'sales' && c.keywords === OLD_SALES_KEYWORDS) ? { ...c, keywords: builtIn(c.id) } : c);
  return { ...h, categories };
}

// Before topics existed there was one "sales_handoff" setting: carry it over as the Sales topic.
function legacyHandoff() {
  const row = getStmt.get('sales_handoff');
  if (!row) return null;
  const old = JSON.parse(row.value);
  const def = DEFAULTS.handoff;
  return {
    ...def,
    enabled: !!old.enabled,
    brief_language: old.brief_language || def.brief_language,
    cooldown_hours: old.cooldown_hours || def.cooldown_hours,
    categories: def.categories.map((c) => (c.id === 'sales' ? { ...c, when: old.when || c.when, team: old.team || [] } : c)),
  };
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
