import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { handleIncoming, registerSender, addNote, scheduleAutoReply } from '../inbox.js';
import { matchRules, forward } from './email-rules.js';

const clients = new Map(); // account id -> { client, stopped, status, error }
let notify = () => {};

export const PRESETS = {
  gmail: { imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: 1, smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1 },
};

export function listAccounts({ withPasswords = false } = {}) {
  return db.prepare('SELECT * FROM email_accounts ORDER BY id').all().map((a) => ({
    ...a,
    password: withPasswords ? a.password : a.password ? '********' : '',
    status: clients.get(a.id)?.status || (a.enabled ? 'stopped' : 'disabled'),
    error: clients.get(a.id)?.error || null,
  }));
}

function getAccount(id) {
  return db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id);
}

function setStatus(id, status, error = null) {
  const entry = clients.get(id);
  if (entry) Object.assign(entry, { status, error });
  notify();
}

// Remove the quoted earlier conversation from a reply so the AI sees only the new text.
export function stripQuoted(text = '') {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
        /^في .+كتب.*:\s*$/.test(line) || /^From: .+/i.test(line) && out.length > 0) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function isAutomated(parsed, account) {
  const h = parsed.headers;
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
  if (!from || from === account.email.toLowerCase()) return true;
  if (/(no-?reply|mailer-daemon|postmaster|notifications?@)/i.test(from)) return true;
  const auto = String(h.get('auto-submitted') || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/(bulk|list|junk|auto_reply)/i.test(String(h.get('precedence') || ''))) return true;
  if (h.get('list-id') || h.get('list-unsubscribe') || h.get('x-autoreply') || h.get('x-autorespond')) return true;
  return false;
}

async function processMessage(account, msg) {
  const parsed = await simpleParser(msg.source);
  if (isAutomated(parsed, account)) return;
  const sender = parsed.from.value[0];
  const text = stripQuoted(parsed.text || '') || (parsed.text || '').trim();
  const references = [].concat(parsed.references || []);
  const conversationId = handleIncoming({
    channel: 'email',
    accountId: account.id,
    externalId: sender.address.toLowerCase(),
    name: sender.name || sender.address,
    handle: sender.address,
    subject: parsed.subject || '(no subject)',
    text: parsed.subject && !text ? parsed.subject : text,
    messageId: parsed.messageId || `${account.id}:${msg.uid}`,
    meta: { subject: parsed.subject },
    convMeta: {
      lastMessageId: parsed.messageId,
      references: [...references, parsed.messageId].filter(Boolean).slice(-10),
      lastSubject: parsed.subject,
    },
    autoReply: false,
  });
  if (!conversationId) return;
  // Forwarding may ask the AI, which can take a while, so don't hold up the next emails.
  applyForwarding(account, parsed, sender, text, conversationId).catch((err) =>
    console.error(`[email:${account.email}] Forwarding failed:`, err.message),
  );
}

async function applyForwarding(account, parsed, sender, text, conversationId) {
  const original = { accountId: account.id, from: sender.address, fromName: sender.name, subject: parsed.subject, text };
  let rules = [];
  try {
    rules = await matchRules(original);
  } catch (err) {
    addNote(conversationId, `Could not check forwarding rules: ${err.message}`);
  }
  if (rules.length) {
    const results = await forward({ transport: transport(account), account, parsed, original, rules });
    for (const r of results) {
      addNote(
        conversationId,
        r.error ? `Forwarding to ${r.to.join(', ')} failed (rule "${r.rule.name}"): ${r.error}` : `Forwarded to ${r.to.join(', ')} (rule "${r.rule.name}")`,
        { rule: r.rule.id },
      );
    }
  }
  // The AI still answers unless one of the matching rules says this email is for the team only.
  if (rules.every((r) => r.ai_reply)) scheduleAutoReply(conversationId);
}

async function fetchNew(account, client) {
  const current = getAccount(account.id);
  const from = (current.last_uid || 0) + 1;
  let maxUid = current.last_uid || 0;
  const batch = [];
  for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true }, { uid: true })) {
    if (msg.uid < from) continue; // IMAP returns the last message for "N:*" when N is past the end.
    batch.push(msg);
    maxUid = Math.max(maxUid, msg.uid);
  }
  for (const msg of batch) {
    try {
      await processMessage(account, msg);
    } catch (err) {
      console.error(`[email:${account.email}] Could not read message ${msg.uid}:`, err.message);
    }
  }
  if (maxUid !== current.last_uid) db.prepare('UPDATE email_accounts SET last_uid = ? WHERE id = ?').run(maxUid, account.id);
}

async function connect(account, entry, attempt = 0) {
  if (entry.stopped) return;
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: !!account.imap_secure,
    auth: { user: account.username, pass: account.password },
    logger: false,
  });
  entry.client = client;
  client.on('error', (err) => setStatus(account.id, 'error', err.message));
  client.on('close', () => {
    if (entry.stopped) return;
    setStatus(account.id, 'reconnecting', entry.error);
    const delay = Math.min(60000, 5000 * 2 ** Math.min(attempt, 4));
    setTimeout(() => connect(account, entry, attempt + 1), delay);
  });
  try {
    setStatus(account.id, 'connecting');
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');
    // On the very first connection only answer mail that arrives from now on.
    if (getAccount(account.id).last_uid == null) {
      db.prepare('UPDATE email_accounts SET last_uid = ? WHERE id = ?').run(Math.max(0, mailbox.uidNext - 1), account.id);
    }
    attempt = 0;
    setStatus(account.id, 'connected');
    let busy = Promise.resolve();
    const check = () => (busy = busy.then(() => fetchNew(account, client)).catch((e) => console.error(`[email:${account.email}]`, e.message)));
    client.on('exists', check);
    await check();
  } catch (err) {
    setStatus(account.id, 'error', err.responseText || err.message);
    client.close();
  }
}

export async function startEmail(onChange) {
  if (onChange) notify = onChange;
  await stopEmail();
  for (const account of db.prepare('SELECT * FROM email_accounts WHERE enabled = 1').all()) {
    const entry = { client: null, stopped: false, status: 'connecting', error: null };
    clients.set(account.id, entry);
    connect(account, entry);
  }
  notify();
}

export async function stopEmail() {
  for (const entry of clients.values()) {
    entry.stopped = true;
    try {
      await entry.client?.logout();
    } catch {
      entry.client?.close();
    }
  }
  clients.clear();
}

export async function testAccount(account) {
  const client = new ImapFlow({
    host: account.imap_host, port: account.imap_port, secure: !!account.imap_secure,
    auth: { user: account.username, pass: account.password }, logger: false,
  });
  await client.connect();
  await client.logout();
  await transport(account).verify();
}

function transport(account) {
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: !!account.smtp_secure,
    auth: { user: account.username, pass: account.password },
  });
}

registerSender('email', async (conv, text) => {
  const account = getAccount(Number(conv.account_id));
  if (!account) throw new Error('Email account no longer exists');
  const subject = conv.meta.lastSubject || conv.subject || '';
  const info = await transport(account).sendMail({
    from: { name: account.name, address: account.email },
    to: conv.external_id,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text,
    inReplyTo: conv.meta.lastMessageId,
    references: conv.meta.references,
    headers: { 'Auto-Submitted': 'auto-replied' },
  });
  return { externalId: info.messageId };
});
