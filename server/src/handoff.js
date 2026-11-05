import { db } from './db.js';
import { getSetting } from './settings.js';
import { chat } from './ai/ollama.js';
import { addNote, getConversation, updateMeta } from './inbox.js';
import { emit } from './realtime.js';

// Team handoff: some requests (sales, maintenance, software, ... set in the dashboard) are passed to a
// person. The AI first asks the customer for the details it needs, then sends the customer's number
// and a short brief to that topic's team on WhatsApp (and/or email). The customer never gets the
// team's own contact.

// The model marks its reply with [ASK:topic] when it asked the customer for details, and
// [HANDOFF:topic] when the request is ready for the team. [SALES] is the older spelling of [ASK].
const TAGS = /\[\s*(HANDOFF|ASK|SALES)\s*(?::\s*([\w-]+)\s*)?\]/gi;
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

export function findCategory(id, { active = true } = {}) {
  const list = active ? activeCategories() : handoffSettings().categories || [];
  return list.find((c) => c.id === id) || null;
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
        team: cleanTeam(c.team).map((m) => ({ name: (m.name || '').trim(), phone: (m.phone || '').trim(), email: (m.email || '').trim() })),
      };
    });
  return {
    enabled: !!value?.enabled,
    brief_language: value?.brief_language || 'English',
    cooldown_hours: Number(value?.cooldown_hours) || 24,
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
  const pending = findCategory(pendingTopic(conv));
  if (pending) {
    return [
      `REQUEST IN PROGRESS (${pending.name}): You already asked this customer for the details we need. Their latest message is their answer.`,
      `Thank them, repeat in one short line what they need, and tell them our ${pending.name} team will contact them shortly.`,
      `Do not ask more questions. ${NO_CONTACT} End your reply with the tag [HANDOFF:${pending.id}].`,
    ].join(' ');
  }
  const open = cats.filter((c) => !recentlyHandedOff(conv, c.id));
  const done = cats.filter((c) => recentlyHandedOff(conv, c.id));
  const lines = [`TEAM HANDOFF: Some requests are passed to a person on our team. Follow these steps instead of any redirect rule. ${NO_CONTACT}`];
  if (open.length) {
    lines.push('Topics (id: when the customer... | details to ask for):');
    for (const c of open) lines.push(`- ${c.id}: ${c.when || c.name} | ${c.ask || 'what exactly they need'}`);
    lines.push(
      'When the customer\'s message matches one of these topics:',
      '1. If they have not yet given the details to ask for, ask for them in one short friendly message and end that reply with the tag [ASK:id], using the topic id.',
      '2. If they already gave the details, thank them, repeat in one line what they need, say our team will contact them shortly, and end the reply with the tag [HANDOFF:id].',
      'Use a tag only when the message really matches a topic.',
    );
  }
  if (done.length) {
    lines.push(`Already passed to our team: ${done.map((c) => c.name).join(', ')}. If the customer asks about that again, tell them our team will contact them soon, and do not use a tag for it.`);
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

// A tag without a topic, or with one the model made up, falls back to the topic in progress,
// then to the only active topic, then to "sales" for the older [SALES]/[HANDOFF] tags.
function resolveTopic(conv, tag) {
  if (findCategory(tag?.topic)) return tag.topic;
  const pending = pendingTopic(conv);
  if (findCategory(pending)) return pending;
  const cats = activeCategories();
  if (cats.length === 1) return cats[0].id;
  return findCategory('sales') ? 'sales' : null;
}

// What to do after the AI replied: remember that it asked for details, or hand off.
export async function afterReply(conversationId, tag) {
  const conv = getConversation(conversationId);
  if (!conv || !handoffEnabled()) return;
  const pending = findCategory(pendingTopic(conv));
  if (pending || tag?.type === 'handoff') {
    // While waiting on details the customer just answered, so hand off even if the model forgot the tag.
    const topic = tag?.type === 'handoff' ? resolveTopic(conv, tag) : pending.id;
    updateMeta(conversationId, { handoffStage: null, salesStage: null });
    if (topic && !recentlyHandedOff(conv, topic)) await handOff(conversationId, { category: topic });
  } else if (tag?.type === 'ask') {
    const topic = resolveTopic(conv, tag);
    if (!topic || recentlyHandedOff(conv, topic)) return;
    updateMeta(conversationId, { handoffStage: { topic, at: Date.now() } });
    addNote(conversationId, `${findCategory(topic).name}: asked the customer for details. Their answer goes to the team.`);
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
