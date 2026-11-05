import { db } from './db.js';
import { getSetting, DEFAULTS } from './settings.js';
import { chat } from './ai/ollama.js';
import { addNote, getConversation, updateMeta } from './inbox.js';
import { emit } from './realtime.js';

// Team handoff: some requests (sales, maintenance, software, ... set in the dashboard) are passed to a
// person. The AI first asks the customer for the details it needs, then sends the customer's number
// and a short brief to that topic's team on WhatsApp (and/or email). The customer never gets the
// team's own contact.

// The flow is short on purpose: when a customer needs a person, the AI asks ONE direct question
// about their request and marks that reply with [ASK:topic]. Whatever the customer answers, they get
// a fixed "a specialist will contact you soon" message and the details go to that topic's team.
// [HANDOFF:topic] (details already given) and [SALES] (older spelling of [ASK]) are still understood.
// Small models write the topic in many ways ([ASK:maintenance], [ASK: Maintenance request]), so any
// text is accepted and matched to a topic afterwards.
const TAGS = /\[\s*(HANDOFF|ASK|SALES)\s*(?::\s*([^\]\n]{1,60}?)\s*)?\]/gi;
const ASK_HOURS = 24;

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');
const cleanTeam = (team) => (team || []).filter((m) => m.name || m.phone || m.email);

export function handoffSettings() {
  return getSetting('handoff');
}

// Topics that can be handed off right now: switched on and with at least one person to send to.
export function activeCategories() {
  const s = handoffSettings();
  if (!s.enabled) return [];
  return (s.categories || []).filter((c) => c.enabled !== false && c.id && cleanTeam(c.team).length);
}

// Arabic spelling varies a lot in chat (أ/إ/ا, ة/ه, ى/ي, diacritics), so compare a simplified form.
function simplify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');
}

const keywordsOf = (c) => String(c.keywords || '').split(/[,،\n]/).map((k) => simplify(k).trim()).filter(Boolean);

// Topics whose keywords appear in the text, best match first (most keywords, then longest).
// Topics already handed off for this chat recently are left out.
export function matchTopics(text, conv) {
  const t = simplify(text);
  if (!t) return [];
  return activeCategories()
    .filter((c) => !recentlyHandedOff(conv, c.id))
    .map((c) => {
      const hits = keywordsOf(c).filter((k) => t.includes(k));
      return { c, n: hits.length, len: hits.reduce((a, k) => a + k.length, 0) };
    })
    .filter((x) => x.n)
    .sort((a, b) => b.n - a.n || b.len - a.len)
    .map((x) => x.c);
}

export function matchTopic(text, conv) {
  if (pendingTopic(conv)) return null;
  return matchTopics(text, conv)[0] || null;
}

// A short reminder at the very end of the prompt. Small models follow that much better than
// instructions buried before the company knowledge.
export function handoffReminder(conv, topics = []) {
  if (!handoffEnabled() || pendingTopic(conv)) return null;
  const list = (Array.isArray(topics) ? topics : [topics]).filter(Boolean);
  if (list.length === 1) {
    const t = list[0];
    return `The customer's latest message needs our ${t.name} team. Do not answer it yourself: ask ONE short, direct question about their request${t.ask ? ` (about: ${t.ask})` : ''} and end with [ASK:${t.id}].`;
  }
  if (list.length > 1) {
    return `The customer's latest message may need one of our teams: ${list.map((t) => `${t.name} [ASK:${t.id}]`).join(' or ')}. Pick the one that fits, ask ONE short, direct question about their request, and end with that tag.`;
  }
  return 'If the customer\'s latest message needs one of the TEAM HANDOFF topics, ask ONE direct question about it and end with [ASK:id].';
}

// The message the customer gets after answering the question.
export function confirmMessage(language) {
  const s = handoffSettings();
  return language === 'Arabic' ? s.confirm_message_ar : s.confirm_message_en;
}

// Find a topic by its id, or by what the model wrote in a tag ("maintenance", "Maintenance request").
export function findCategory(ref, { active = true } = {}) {
  if (!ref) return null;
  const list = active ? activeCategories() : handoffSettings().categories || [];
  const exact = list.find((c) => c.id === ref);
  if (exact) return exact;
  const r = simplify(ref).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!r) return null;
  const name = (c) => simplify(c.name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const id = (c) => c.id.replace(/-/g, ' ');
  return list.find((c) => name(c) === r || id(c) === r)
    || list.find((c) => name(c).includes(r) || r.includes(id(c)) || r.includes(name(c)))
    || null;
}

export function handoffEnabled() {
  return activeCategories().length > 0;
}

// Everyone on any team: the AI never answers their messages.
export function isTeamNumber(phone) {
  const d = digitsOf(phone);
  if (!d) return false;
  return (handoffSettings().categories || []).some((c) => cleanTeam(c.team).some((m) => digitsOf(m.phone) === d));
}

// Give each topic a short, stable id the model can write in a tag, and drop empty team rows.
export function normalizeHandoff(value) {
  const used = new Set();
  const categories = (value?.categories || [])
    .filter((c) => (c.name || '').trim() || (c.when || '').trim())
    .map((c, i) => {
      let id = String(c.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!id) id = (c.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
      if (!id) id = `topic${i + 1}`;
      while (used.has(id)) id = `${id}-${i + 1}`;
      used.add(id);
      return {
        id,
        name: (c.name || '').trim() || id,
        enabled: c.enabled !== false,
        when: (c.when || '').trim(),
        ask: (c.ask || '').trim(),
        keywords: String(c.keywords ?? '').trim(),
        team: cleanTeam(c.team).map((m) => ({ name: (m.name || '').trim(), phone: (m.phone || '').trim(), email: (m.email || '').trim() })),
      };
    });
  return {
    enabled: !!value?.enabled,
    brief_language: value?.brief_language || 'English',
    cooldown_hours: Number(value?.cooldown_hours) || 24,
    confirm_message_en: String(value?.confirm_message_en || '').trim() || DEFAULTS.handoff.confirm_message_en,
    confirm_message_ar: String(value?.confirm_message_ar || '').trim() || DEFAULTS.handoff.confirm_message_ar,
    categories,
  };
}

// While handoff is on, the customer must never be given a team's own contact, so redirect rules that
// point at a team member's number, or that are about a handoff topic, are left out of the prompt.
const SALES_WORDS = /sale|sell|buy|purchas|مبيع|شراء|اشتر|بيع/i;
export function allowRedirect(rule) {
  const cats = activeCategories();
  if (!cats.length) return true;
  const text = `${rule.name} ${rule.when_text}`.toLowerCase();
  for (const c of cats) {
    if (c.id === 'sales' && SALES_WORDS.test(text)) return false;
    if (c.name.length >= 4 && text.includes(c.name.toLowerCase())) return false;
  }
  const value = digitsOf(rule.value);
  return !cats.some((c) => cleanTeam(c.team).some((m) => {
    const d = digitsOf(m.phone).slice(-9);
    return d.length >= 7 && value.includes(d);
  }));
}

function cooldownMs() {
  return (handoffSettings().cooldown_hours || 24) * 3600e3;
}

// When this conversation was last handed off for a topic (older chats only knew "sales").
function lastHandoff(conv, id) {
  const m = conv?.meta || {};
  return m.handoffs?.[id] || (id === 'sales' ? m.lastHandoffAt : null) || null;
}

function recentlyHandedOff(conv, id) {
  const at = lastHandoff(conv, id);
  return !!at && Date.now() - at < cooldownMs();
}

// After the AI asked for details, the topic it is waiting on (valid for a day).
export function pendingTopic(conv) {
  const m = conv?.meta || {};
  if (m.handoffStage?.topic && Date.now() - (m.handoffStage.at || 0) < ASK_HOURS * 3600e3) return m.handoffStage.topic;
  if (m.salesStage === 'asking' && Date.now() - (m.salesAskedAt || 0) < ASK_HOURS * 3600e3) return 'sales';
  return null;
}

const NO_CONTACT = 'Never give the customer a phone number, WhatsApp link or any contact of our team: our team contacts the customer.';

// The part of the system prompt that drives handoff conversations.
export function handoffPrompt(conv) {
  const cats = activeCategories();
  if (!cats.length) return null;
  const open = cats.filter((c) => !recentlyHandedOff(conv, c.id));
  const done = cats.filter((c) => recentlyHandedOff(conv, c.id));
  const lines = [`TEAM HANDOFF: Some requests must be handled by a specialist on our team. ${NO_CONTACT}`];
  if (open.length) {
    lines.push('Topics (tag: when the customer... | what to ask about):');
    for (const c of open) lines.push(`- [ASK:${c.id}] ${c.name}: ${c.when || c.name} | ${c.ask || 'what exactly they need'}`);
    lines.push(
      'When the customer\'s message needs one of these topics, do not answer the request yourself and do not use a redirect rule.',
      'Ask ONE short, direct question about their request (for example about the points listed for that topic), and end that reply with the topic\'s tag, exactly as written above.',
      'This applies in Arabic too (for example "بدي اشتري", "عندي عطل", "بدي صيانة"). Use a tag only when the message really needs a specialist.',
    );
  }
  if (done.length) {
    lines.push(`Already passed to a specialist: ${done.map((c) => c.name).join(', ')}. If the customer asks about that again, tell them a specialist will contact them soon, and do not use a tag for it.`);
  }
  return lines.join('\n');
}

// Remove the tags from a reply and say which one was there: { type: 'ask' | 'handoff', topic }.
export function takeTags(reply) {
  let tag = null;
  for (const m of reply.matchAll(TAGS)) {
    const type = m[1].toUpperCase() === 'HANDOFF' ? 'handoff' : 'ask';
    if (!tag || type === 'handoff') tag = { type, topic: m[2]?.toLowerCase() || null };
  }
  return { reply: reply.replace(TAGS, '').replace(/[ \t]+\n/g, '\n').trim(), tag };
}

// Which topic a tag means. When the model wrote no topic, or one we don't have, look at the
// customer's recent messages: first the keywords, then (only if still unclear) ask the model.
async function resolveTopic(conv, tag) {
  const named = findCategory(tag?.topic);
  if (named) return named.id;
  const pending = findCategory(pendingTopic(conv));
  if (pending) return pending.id;
  const cats = activeCategories().filter((c) => !recentlyHandedOff(conv, c.id));
  if (cats.length <= 1) return cats[0]?.id || null;
  const recent = db
    .prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 3")
    .all(conv.id)
    .map((m) => m.text)
    .join('\n');
  const byKeyword = matchTopics(recent, conv)[0];
  if (byKeyword) return byKeyword.id;
  const answer = await chat([{
    role: 'user',
    content: `A customer wrote:\n${recent}\n\nWhich of these teams should handle it?\n` +
      cats.map((c) => `${c.id}: ${c.name} (${c.when})`).join('\n') + '\n\nAnswer with only the id.',
  }], { temperature: 0 });
  return findCategory(answer.trim().split(/\s+/)[0]?.replace(/[^\w-]/g, ''))?.id || findCategory(answer)?.id || null;
}

// What to do after the AI replied: remember which topic it asked about, or hand off.
export async function afterReply(conversationId, tag) {
  const conv = getConversation(conversationId);
  if (!conv || !handoffEnabled() || !tag) return;
  const topic = await resolveTopic(conv, tag);
  if (!topic) {
    addNote(conversationId, 'The AI thinks this customer needs a specialist but could not tell which team. Use "Send to team…" above.');
    return;
  }
  if (tag.type === 'handoff') {
    updateMeta(conversationId, { handoffStage: null, salesStage: null });
    if (!recentlyHandedOff(conv, topic)) await handOff(conversationId, { category: topic });
  } else if (!recentlyHandedOff(conv, topic)) {
    updateMeta(conversationId, { handoffStage: { topic, at: Date.now() } });
    addNote(conversationId, `${findCategory(topic).name}: asked the customer one question. Their answer goes to the team.`);
  }
}

// How the team can reach the customer, per channel.
export function contactOf(conv) {
  if (conv.channel === 'whatsapp') {
    const phone = conv.meta?.phone || (conv.external_id.endsWith('@s.whatsapp.net') ? '+' + conv.external_id.split('@')[0] : null);
    return phone
      ? { label: 'WhatsApp', value: phone, link: `https://wa.me/${digitsOf(phone)}` }
      : { label: 'WhatsApp', value: 'number hidden by WhatsApp, reply from the dashboard', link: null };
  }
  if (conv.channel === 'telegram') {
    return conv.contact_handle?.startsWith('@')
      ? { label: 'Telegram', value: conv.contact_handle, link: `https://t.me/${conv.contact_handle.slice(1)}` }
      : { label: 'Telegram', value: `user ${conv.contact_handle}, reply from the dashboard`, link: null };
  }
  if (conv.channel === 'email') return { label: 'Email', value: conv.external_id, link: `mailto:${conv.external_id}` };
  return { label: conv.channel, value: conv.contact_handle || conv.external_id, link: null };
}

async function writeBrief(conv, category, language) {
  const history = db
    .prepare("SELECT direction, text FROM messages WHERE conversation_id = ? AND direction <> 'note' ORDER BY id DESC LIMIT 12")
    .all(conv.id)
    .reverse()
    .map((m) => `${m.direction === 'in' ? 'Customer' : 'Us'}: ${m.text}`)
    .join('\n');
  const brief = await chat(
    [{
      role: 'user',
      content: `Here is a chat between a customer and our support assistant:\n\n${history}\n\n` +
        `Write a brief for our ${category.name} team in ${language}: in 2 to 4 short lines, what the customer needs and any useful details` +
        `${category.ask ? ` (${category.ask})` : ''}. Only facts from the chat. No greeting, no headings.`,
    }],
    { temperature: 0.2 },
  );
  return takeTags(brief).reply;
}

// Optional email delivery, through the first working email account.
let emailSender = null;
export function registerEmailSender(fn) {
  emailSender = fn;
}
let whatsappSender = null;
export function registerWhatsAppSender(fn) {
  whatsappSender = fn;
}

export async function handOff(conversationId, { category: categoryId = 'sales', reason = 'auto' } = {}) {
  const conv = getConversation(conversationId);
  if (!conv) throw new Error('Conversation not found');
  const s = handoffSettings();
  const category = findCategory(categoryId, { active: false }) || (s.categories || [])[0];
  if (!category) throw new Error('Add a topic under Team handoff first');
  const team = cleanTeam(category.team);
  if (!team.length) throw new Error(`Add at least one person to "${category.name}" under Team handoff`);
  if (reason === 'auto' && recentlyHandedOff(conv, category.id)) return [];

  const previous = lastHandoff(conv, category.id);
  const stamp = (at) => updateMeta(conversationId, { handoffs: { ...(getConversation(conversationId).meta.handoffs || {}), [category.id]: at } });
  stamp(Date.now()); // set first so two quick messages don't send twice
  let brief;
  try {
    brief = await writeBrief(conv, category, s.brief_language || 'English');
  } catch (err) {
    brief = `(Could not write a summary: ${err.message})`;
  }
  const contact = contactOf(conv);
  const lastCustomer = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(conversationId)?.text;
  const text = [
    `🔔 New request: ${category.name}`,
    `Name: ${conv.contact_name || conv.contact_handle || 'Unknown'}`,
    `${contact.label}: ${contact.value}${contact.link ? `\n${contact.link}` : ''}`,
    '',
    brief,
    lastCustomer ? `\nLast message: "${lastCustomer.slice(0, 300)}"` : '',
  ].join('\n').trim();

  const results = [];
  for (const member of team) {
    if (member.phone) {
      try {
        if (!whatsappSender) throw new Error('WhatsApp is not available');
        await whatsappSender(member.phone, text);
        results.push({ member, via: 'WhatsApp' });
      } catch (err) {
        results.push({ member, via: 'WhatsApp', error: err.message });
      }
    }
    if (member.email) {
      try {
        if (!emailSender) throw new Error('No email account is set up');
        await emailSender(member.email, `New request (${category.name}): ${conv.contact_name || contact.value}`, text);
        results.push({ member, via: 'email' });
      } catch (err) {
        results.push({ member, via: 'email', error: err.message });
      }
    }
  }
  const ok = results.filter((r) => !r.error);
  const leads = [...new Set([...(getConversation(conversationId).meta.leads || []), category.name])];
  updateMeta(conversationId, { leads, handoffStage: null, salesStage: null, lastHandoffBrief: brief });
  for (const r of results) {
    addNote(conversationId, r.error
      ? `Could not send to ${r.member.name || r.member.phone || r.member.email} (${category.name}) by ${r.via}: ${r.error}`
      : `Sent to ${category.name} team: ${r.member.name || ''} (${r.via === 'WhatsApp' ? r.member.phone : r.member.email})`.replace('  ', ' '));
  }
  if (!ok.length) stamp(previous); // let it try again next time
  emit('conversation', getConversation(conversationId));
  return results;
}
