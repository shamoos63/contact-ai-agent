import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const db = new Database(path.join(DATA_DIR, 'agent.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,            -- whatsapp | telegram | email | facebook | instagram
  account_id TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL,        -- chat id / email address / PSID
  contact_name TEXT,
  contact_handle TEXT,
  subject TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  auto_reply INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  unread INTEGER NOT NULL DEFAULT 0,
  last_message TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, account_id, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,          -- in | out
  sender TEXT NOT NULL,             -- customer | ai | agent
  text TEXT NOT NULL,
  external_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS kb_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,               -- file | url | text
  title TEXT NOT NULL,
  origin TEXT,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | ready | error
  error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);

CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  when_text TEXT NOT NULL,          -- when the customer asks about...
  value TEXT NOT NULL,              -- link or phone number to send
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 465,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_uid INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
