import { db } from '../db.js';
import { chat } from '../ai/ollama.js';

export function listRules() {
  return db.prepare('SELECT * FROM email_rules ORDER BY id').all();
}

const keywordsOf = (text) => text.split(/[,،\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
const addressesOf = (text) => text.split(/[,;\s]+/).map((a) => a.trim()).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));

export function validateRule(r) {
  if (!r.name?.trim()) return 'Give the rule a name';
  if (!r.match_text?.trim()) return r.match_type === 'ai' ? 'Describe which emails to forward' : 'Add at least one keyword';
  if (!addressesOf(r.forward_to || '').length) return 'Add at least one valid email address to forward to';
  return null;
}

function keywordMatch(rule, email) {
  const fields = {
    from: `${email.fromName || ''} ${email.from || ''}`,
    subject: email.subject || '',
    body: email.text || '',
  };
  const haystack = (rule.match_field === 'any' ? Object.values(fields).join('\n') : fields[rule.match_field] || '').toLowerCase();
  return keywordsOf(rule.match_text).some((k) => haystack.includes(k));
}

// Ask the local model which of the described rules fit this email. One call covers all AI rules.
async function aiMatches(rules, email) {
  if (!rules.length) return [];
  const list = rules.map((r, i) => `${i + 1}. ${r.match_text}`).join('\n');
  const prompt = [
    'You sort incoming business emails. Here are the forwarding rules:',
    list,
    '',
    'Email:',
    `From: ${email.fromName || ''} <${email.from}>`,
    `Subject: ${email.subject || ''}`,
    (email.text || '').slice(0, 3000),
    '',
    'Which rule numbers clearly apply to this email? Answer with only the numbers separated by commas, or the word none.',
  ].join('\n');
  const answer = await chat([{ role: 'user', content: prompt }], { temperature: 0 });
  if (/none/i.test(answer) && !/\d/.test(answer)) return [];
  const picked = new Set((answer.match(/\d+/g) || []).map(Number));
  return rules.filter((_, i) => picked.has(i + 1));
}

// email: { accountId, from, fromName, subject, text }
export async function matchRules(email) {
  const rules = listRules().filter((r) => r.enabled && (email.accountId == null || r.account_id == null || r.account_id === email.accountId));
  const byKeyword = rules.filter((r) => r.match_type !== 'ai' && keywordMatch(r, email));
  const byAi = await aiMatches(rules.filter((r) => r.match_type === 'ai'), email);
  return [...byKeyword, ...byAi];
}

function forwardBody(parsed, original) {
  const header = [
    '---------- Forwarded message ---------',
    `From: ${original.fromName ? `${original.fromName} <${original.from}>` : original.from}`,
    `Date: ${parsed.date ? parsed.date.toUTCString() : ''}`,
    `Subject: ${parsed.subject || ''}`,
    `To: ${parsed.to?.text || ''}`,
    '',
  ].join('\n');
  const escape = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return {
    text: `${header}\n${parsed.text || ''}`,
    html: parsed.html ? `<div>${escape(header).replace(/\n/g, '<br>')}</div><br>${parsed.html}` : undefined,
  };
}

// Forward an email to every matched rule's addresses. Returns [{ rule, to, error? }].
export async function forward({ transport, account, parsed, original, rules }) {
  const results = [];
  for (const rule of rules) {
    const to = addressesOf(rule.forward_to);
    const body = forwardBody(parsed, original);
    try {
      await transport.sendMail({
        from: { name: account.name, address: account.email },
        to,
        replyTo: original.from,
        subject: /^fwd?:/i.test(parsed.subject || '') ? parsed.subject : `Fwd: ${parsed.subject || ''}`,
        ...body,
        attachments: rule.include_attachments
          ? (parsed.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid }))
          : [],
        headers: { 'Auto-Submitted': 'auto-forwarded' },
      });
      results.push({ rule, to });
    } catch (err) {
      results.push({ rule, to, error: err.message });
    }
  }
  return results;
}
