import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from './ollama.js';
import { search } from '../kb/index.js';

export function redirectRules() {
  return db.prepare('SELECT * FROM redirects WHERE enabled = 1 ORDER BY id').all();
}

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN = /[A-Za-z]/;
// Chinese, Japanese and Korean characters. Qwen models sometimes drift into Chinese.
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/;

// The language of the customer's latest message that has letters in it (Arabic or English).
export function detectLanguage(messages) {
  for (const m of [...messages].reverse()) {
    if (m.role !== 'user') continue;
    if (ARABIC.test(m.content)) return 'Arabic';
    if (LATIN.test(m.content)) return 'English';
  }
  return 'English';
}

function wrongLanguage(reply, language) {
  if (CJK.test(reply)) return true;
  return language === 'Arabic' && !ARABIC.test(reply);
}

export function buildSystemPrompt(knowledge, language = 'English') {
  const company = getSetting('company_name');
  const base = getSetting('system_prompt').replaceAll('{company}', company);
  const rules = redirectRules();
  const parts = [
    base,
    '',
    `LANGUAGE: The customer is writing in ${language}. Write your whole reply in ${language} only. Never answer in Chinese or any other language, even if the knowledge below is in another language.`,
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
    .prepare("SELECT direction, sender, text FROM messages WHERE conversation_id = ? AND error IS NULL AND direction <> 'note' ORDER BY id DESC LIMIT 10")
    .all(conversationId)
    .reverse();
  return answer(history.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text })));
}

// messages: [{ role: 'user' | 'assistant', content }]; the last one should be from the user.
export async function answer(messages) {
  const recentUser = messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join('\n');
  let knowledge = [];
  try {
    knowledge = await search(recentUser, { k: 4 });
  } catch (err) {
    console.error('[agent] Knowledge search failed:', err.message);
  }
  const language = detectLanguage(messages);
  const prompt = [
    { role: 'system', content: buildSystemPrompt(knowledge, language) },
    ...messages,
    // A last reminder right before the answer is what keeps small models in the right language.
    { role: 'system', content: `Answer the customer now, in ${language} only.` },
  ];
  let reply = await chat(prompt);
  if (reply && wrongLanguage(reply, language)) {
    console.warn(`[agent] Reply was not in ${language}, asking again`);
    reply = await chat(
      [...prompt, { role: 'assistant', content: reply }, { role: 'user', content: `Please write that again in ${language} only.` }],
      { temperature: 0 },
    );
    if (wrongLanguage(reply, language)) reply = '';
  }
  return { reply: reply || getSetting('fallback_message'), sources: knowledge, language };
}
