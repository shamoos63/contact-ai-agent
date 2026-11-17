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

CREATE TABLE IF NOT EXISTS email_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'keywords', -- keywords | ai
  match_text TEXT NOT NULL,         -- comma-separated keywords, or a description for the AI
  match_field TEXT NOT NULL DEFAULT 'any',     -- any | from | subject | body (keywords only)
  forward_to TEXT NOT NULL,         -- comma-separated addresses
  account_id INTEGER,               -- NULL = all email accounts
  ai_reply INTEGER NOT NULL DEFAULT 1,         -- still let the AI answer the customer
  include_attachments INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner assistant: reminders, appointments and messages/emails to send later.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- reminder | event | message | email | briefing
  owner_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  owner_name TEXT,
  run_at TEXT NOT NULL,             -- ISO time (UTC) when it fires
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | cancelled
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, run_at);
-- Names and numbers each assistant owner asked the bot to remember. Each owner has their own list.
CREATE TABLE IF NOT EXISTS owner_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_owner_contacts ON owner_contacts(owner_key);
-- Dates the owner asked to be reminded about (domains, licences, subscriptions…).
CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deadlines ON deadlines(owner_key, due_date);
-- Abilities owners taught by chat: rules for customer answers, and recurring jobs.
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- 'rule' | 'job'
  text TEXT NOT NULL,             -- the rule, or the instruction the job runs as if the owner said it
  owner_name TEXT,
  owner_conversation_id INTEGER,
  repeat TEXT,                    -- job: 'daily' | 'weekly'
  weekday INTEGER,                -- job, weekly: 0 = Sunday
  time TEXT,                      -- job: 'HH:mm' local time
  next_run TEXT,                  -- job: ISO time
  last_run TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Things owners asked for that the assistant can't do yet: a to-do list for its developer.
CREATE TABLE IF NOT EXISTS wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  owner_name TEXT,
  times INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open', -- open | done
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Draft mode: replies on topics the owner hasn't approved enough times yet wait for the owner.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price TEXT,
  description TEXT,
  image TEXT,
  in_stock INTEGER NOT NULL DEFAULT 1,
  source_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  question TEXT,
  text TEXT NOT NULL,
  source_id INTEGER,              -- the Knowledge source the answer came from (its "topic")
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | edited | dropped
  final_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
-- How many times the owner approved answers from each Knowledge source without changes.
CREATE TABLE IF NOT EXISTS trust (
  source_id INTEGER PRIMARY KEY,
  approvals INTEGER NOT NULL DEFAULT 0
);
-- Replies the team corrected or wrote themselves: examples of tone and length for the AI.
CREATE TABLE IF NOT EXISTS style_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_text TEXT NOT NULL,
  ai_text TEXT,
  final_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Things the AI proposes to learn (from the team's own replies, found in its weekly self-review).
-- Nothing reaches Knowledge until an owner approves it.
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- 'knowledge'
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reason TEXT,
  message_id INTEGER UNIQUE,      -- the message it was learned from (each one only once)
  conversation_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  source_id INTEGER,              -- the Knowledge source it became
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
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

// Columns added after the first release.
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (!columns('kb_sources').includes('audience')) db.exec("ALTER TABLE kb_sources ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'");

