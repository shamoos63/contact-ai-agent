import { db } from '../db.js';
import { getSetting } from '../settings.js';
import { chat } from './ollama.js';
import { search } from '../kb/index.js';
import { handoffPrompt, handoffReminder, matchTopic, takeTags, allowRedirect } from '../handoff.js';
import { getConversation } from '../inbox.js';

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

// The instructions part of the prompt. It is the same from one message to the next, so Ollama can
// reuse the work it already did on it and only read the new parts (knowledge, latest messages).
export function buildRulesPrompt(conv = null) {
  const company = getSetting('company_name');
  const base = getSetting('system_prompt').replaceAll('{company}', company);
  const rules = redirectRules().filter(allowRedirect);
  const parts = [
    base,
    '',
    'LANGUAGE: Reply in the language of the customer\'s latest message (Arabic or English) only. Never answer in Chinese or any other language, even if the knowledge is in another language.',
    'Never invent prices, policies, phone numbers or links. Use only the company knowledge and redirect rules.',
    `If the knowledge does not answer the question, reply with this message (translated to the customer's language): "${getSetting('fallback_message')}"`,
  ];
  if (rules.length) {
    parts.push('', 'REDIRECT RULES (when a rule applies, include its exact link or phone number in your reply):');
    for (const r of rules) parts.push(`- ${r.name}: when ${r.when_text} -> give the customer: ${r.value}`);
  }
  const handoff = handoffPrompt(conv);
  if (handoff) parts.push('', handoff);
  return parts.join('\n');
}

export function buildKnowledgePrompt(knowledge) {
  const parts = ['COMPANY KNOWLEDGE (for the customer\'s latest question):'];
  if (knowledge.length) knowledge.forEach((k, i) => parts.push(`[${i + 1}] (${k.title}) ${k.text}`));
  else parts.push('(no relevant knowledge found for this question)');
  return parts.join('\n');
}

export function buildSystemPrompt(knowledge, language = 'English', conv = null) {
  return [buildRulesPrompt(conv), '', buildKnowledgePrompt(knowledge)].join('\n');
}

// Produce a reply for a conversation, based on its recent history and the knowledge base.
export async function generateReply(conversationId) {
  const history = db
    .prepare("SELECT direction, sender, text FROM messages WHERE conversation_id = ? AND error IS NULL AND direction <> 'note' ORDER BY id DESC LIMIT 8")
    .all(conversationId)
    .reverse();
  const messages = history.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text }));
  return answer(messages, { conv: getConversation(conversationId) });
}

// messages: [{ role: 'user' | 'assistant', content }]; the last one should be from the user.
export async function answer(messages, { conv = null } = {}) {
  const recentUser = messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join('\n');
  let knowledge = [];
  try {
    knowledge = await search(recentUser, { k: 3 });
  } catch (err) {
    console.error('[agent] Knowledge search failed:', err.message);
  }
  const language = detectLanguage(messages);
  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const topic = matchTopic(latest, conv);
  const prompt = [
    // Fixed instructions first, then what changes per message, so the start of the prompt is reused.
    { role: 'system', content: buildRulesPrompt(conv) },
    { role: 'system', content: buildKnowledgePrompt(knowledge) },
    ...messages,
    // A last reminder right before the answer is what keeps small models on track.
    { role: 'system', content: [handoffReminder(conv, topic), `Answer the customer now, in ${language} only.`].filter(Boolean).join('\n') },
  ];
  let { reply, tag } = takeTags(await chat(prompt));
  // The message clearly matched a topic's keywords but the model forgot the tag: still start the handoff.
  if (!tag && topic) tag = { type: 'ask', topic: topic.id };
  if (reply && wrongLanguage(reply, language)) {
    console.warn(`[agent] Reply was not in ${language}, asking again`);
    reply = takeTags(await chat(
      [...prompt, { role: 'assistant', content: reply }, { role: 'user', content: `Please write that again in ${language} only.` }],
      { temperature: 0 },
    )).reply;
    if (wrongLanguage(reply, language)) reply = '';
  }
  return { reply: reply || getSetting('fallback_message'), sources: knowledge, language, tag };
}
