import { db } from './db.js';
import { getSetting } from './settings.js';
import { chat } from './ai/ollama.js';
import { addNote, getConversation, updateMeta } from './inbox.js';
import { emit } from './realtime.js';

// Sales handoff: when a customer wants to buy, send their contact details and a short brief
// to the sales team on WhatsApp (and/or email), so a person can follow up.

// The model marks its reply with [SALES] when it asked the customer what they need,
// and [HANDOFF] when the request is ready to pass to the sales team.
const TAGS = /\[\s*(HANDOFF|SALES)\s*\]/gi;

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');

export function teamMembers() {
  return (getSetting('sales_handoff').team || []).filter((m) => m.name || m.phone || m.email);
}

export function handoffEnabled() {
  return !!getSetting('sales_handoff').enabled && teamMembers().length > 0;
}

export function isTeamNumber(phone) {
  const d = digitsOf(phone);
  return !!d && teamMembers().some((m) => digitsOf(m.phone) === d);
}

// While handoff is on, the customer must never be given the sales team's own contact, so redirect
// rules about sales, or that point at a team member's number, are left out of the prompt.
const SALES_WORDS = /sale|sell|buy|purchas|مبيع|شراء|اشتر|بيع/i;
export function allowRedirect(rule) {
  if (!handoffEnabled()) return true;
  if (SALES_WORDS.test(`${rule.name} ${rule.when_text}`)) return false;
  const value = digitsOf(rule.value);
  return !teamMembers().some((m) => {
    const d = digitsOf(m.phone).slice(-9);
    return d.length >= 7 && value.includes(d);
  });
}

function recentlyHandedOff(conv) {
  const hours = getSetting('sales_handoff').cooldown_hours || 24;
  return conv?.meta?.lastHandoffAt && Date.now() - conv.meta.lastHandoffAt < hours * 3600e3;
}

// A sales request is "asking" after the AI asked the customer what they need (valid for a day).
export function salesStage(conv) {
  const m = conv?.meta || {};
  if (m.salesStage === 'asking' && Date.now() - (m.salesAskedAt || 0) < 24 * 3600e3) return 'asking';
  return null;
}

// The part of the system prompt that drives the sales conversation.
export function handoffPrompt(conv) {
  if (!handoffEnabled()) return null;
  const s = getSetting('sales_handoff');
  const noContact = 'Never give the customer a phone number, WhatsApp link or any contact of our sales team: our sales manager contacts the customer.';
  if (salesStage(conv) === 'asking') {
    return [
      'SALES REQUEST IN PROGRESS: You already asked this customer what they need. Their latest message is their answer.',
      'Thank them, repeat in one short line what they need, and tell them our sales manager will contact them shortly on this number.',
      `Do not ask more questions. ${noContact} End your reply with the tag [HANDOFF].`,
    ].join(' ');
  }
  if (recentlyHandedOff(conv)) {
    return `SALES: This customer was already passed to our sales manager. If they ask about buying, tell them the sales manager will contact them soon. ${noContact}`;
  }
  return [
    `SALES REQUESTS: When ${s.when}, follow these steps instead of any redirect rule. ${noContact}`,
    '1. If the customer has not yet said exactly what they need, ask them in one short friendly message (for example: which product or service, how many, budget, delivery city). End that reply with the tag [SALES].',
    '2. If they already explained what they need, thank them, repeat in one line what they need, say our sales manager will contact them shortly on this number, and end the reply with the tag [HANDOFF].',
  ].join('\n');
}

// Remove the tags from a reply and say which one was there.
export function takeTags(reply) {
  let tag = null;
  for (const m of reply.matchAll(TAGS)) tag = m[1].toUpperCase() === 'HANDOFF' || tag === 'handoff' ? 'handoff' : 'sales';
  return { reply: reply.replace(TAGS, '').replace(/[ \t]+\n/g, '\n').trim(), tag };
}

// What to do after the AI replied: remember that it asked about needs, or hand off.
export async function afterReply(conversationId, tag) {
  const conv = getConversation(conversationId);
  if (!conv || !handoffEnabled()) return;
  if (salesStage(conv) === 'asking' || tag === 'handoff') {
    // In the "asking" stage the customer just answered, so hand off even if the model forgot the tag.
    if (!recentlyHandedOff(conv)) await handOff(conversationId);
    updateMeta(conversationId, { salesStage: null });
  } else if (tag === 'sales' && !recentlyHandedOff(conv)) {
    updateMeta(conversationId, { salesStage: 'asking', salesAskedAt: Date.now() });
    addNote(conversationId, 'Sales request: asked the customer what they need. Their answer goes to the sales team.');
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

async function writeBrief(conv, language) {
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
        `Write a brief for our sales team in ${language}: in 2 to 4 short lines, what the customer wants and any useful details ` +
        `(product, quantity, budget, location, timing). Only facts from the chat. No greeting, no headings.`,
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

export async function handOff(conversationId, { reason = 'auto' } = {}) {
  const conv = getConversation(conversationId);
  if (!conv) throw new Error('Conversation not found');
  const s = getSetting('sales_handoff');
  const team = teamMembers();
  if (!team.length) throw new Error('Add at least one sales team member in Settings → Sales handoff');
  if (reason === 'auto' && conv.meta.lastHandoffAt && Date.now() - conv.meta.lastHandoffAt < (s.cooldown_hours || 24) * 3600e3) return [];

  updateMeta(conversationId, { lastHandoffAt: Date.now() }); // set first so two quick messages don't send twice
  let brief;
  try {
    brief = await writeBrief(conv, s.brief_language || 'English');
  } catch (err) {
    brief = `(Could not write a summary: ${err.message})`;
  }
  const contact = contactOf(conv);
  const lastCustomer = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(conversationId)?.text;
  const text = [
    '🔔 New sales lead',
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
        await emailSender(member.email, `New sales lead: ${conv.contact_name || contact.value}`, text);
        results.push({ member, via: 'email' });
      } catch (err) {
        results.push({ member, via: 'email', error: err.message });
      }
    }
  }
  const ok = results.filter((r) => !r.error);
  updateMeta(conversationId, { salesLead: true, salesStage: null, lastHandoffBrief: brief });
  for (const r of results) {
    addNote(conversationId, r.error
      ? `Could not send the lead to ${r.member.name || r.member.phone || r.member.email} by ${r.via}: ${r.error}`
      : `Sent to sales: ${r.member.name || ''} (${r.via === 'WhatsApp' ? r.member.phone : r.member.email})`.replace('  ', ' '));
  }
  if (!ok.length) updateMeta(conversationId, { lastHandoffAt: null }); // let it try again next time
  emit('conversation', getConversation(conversationId));
  return results;
}
