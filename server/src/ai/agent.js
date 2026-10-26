import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from './ollama.js';
import { search } from '../kb/index.js';

export function redirectRules() {
  return db.prepare('SELECT * FROM redirects WHERE enabled = 1 ORDER BY id').all();
}

export function buildSystemPrompt(knowledge) {
  const company = getSetting('company_name');
  const base = getSetting('system_prompt').replaceAll('{company}', company);
  const rules = redirectRules();
  const parts = [
    base,
    '',
    'LANGUAGE: Always reply in the same language the customer wrote in. If they write in Arabic (any dialect), reply in Arabic. If they write in English, reply in English.',
    'Never invent prices, policies, phone numbers or links. Use only the knowledge and redirect rules below.',
    `If the knowledge does not answer the question, reply with this message (translated to the customer's language): "${getSetting('fallback_message')}"`,
  ];
  if (rules.length) {
    parts.push('', 'REDIRECT RULES (when a rule applies, include its exact link or phone number in your reply):');
    for (const r of rules) parts.push(`- ${r.name}: when ${r.when_text} -> give the customer: ${r.value}`);
  }
  parts.push('', 'COMPANY KNOWLEDGE:');
  if (knowledge.length) knowledge.forEach((k, i) => parts.push(`[${i + 1}] (${k.title}) ${k.text}`));
  else parts.push('(no relevant knowledge found for this question)');
  return parts.join('\n');
}

// Produce a reply for a conversation, based on its recent history and the knowledge base.
export async function generateReply(conversationId) {
  const history = db
    .prepare('SELECT direction, sender, text FROM messages WHERE conversation_id = ? AND error IS NULL ORDER BY id DESC LIMIT 12')
    .all(conversationId)
    .reverse();
  return answer(history.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text })));
}

// messages: [{ role: 'user' | 'assistant', content }]; the last one should be from the user.
export async function answer(messages) {
  const recentUser = messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join('\n');
  let knowledge = [];
  try {
    knowledge = await search(recentUser, { k: 5 });
  } catch (err) {
    console.error('[agent] Knowledge search failed:', err.message);
  }
  const reply = await chat([{ role: 'system', content: buildSystemPrompt(knowledge) }, ...messages]);
  return { reply: reply || getSetting('fallback_message'), sources: knowledge };
}
