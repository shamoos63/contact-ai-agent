import { db } from './db.js';
import { getSetting } from './settings.js';
import { chat } from './ai/ollama.js';
import { addNote, getConversation, updateMeta } from './inbox.js';
import { emit } from './realtime.js';

// Sales handoff: when a customer wants to buy, send their contact details and a short brief
// to the sales team on WhatsApp (and/or email), so a person can follow up.

export const HANDOFF_TAG = /\[\s*HANDOFF\s*\]/gi;

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');

export function teamMembers() {
  return (getSetting('sales_handoff').team || []).filter((m) => m.name || m.phone || m.email);
}

export function isTeamNumber(phone) {
  const d = digitsOf(phone);
  return !!d && teamMembers().some((m) => digitsOf(m.phone) === d);
}

export function handoffPrompt() {
  const s = getSetting('sales_handoff');
  if (!s.enabled || !teamMembers().length) return null;
  return `SALES HANDOFF: If ${s.when}, answer what you can, tell the customer that a member of our sales team will contact them shortly, and put the tag [HANDOFF] at the very end of your reply.`;
}

// Remove the tag from a reply and say whether it was there.
export function takeHandoffTag(reply) {
  const tagged = HANDOFF_TAG.test(reply);
  HANDOFF_TAG.lastIndex = 0;
  return { reply: reply.replace(HANDOFF_TAG, '').trim(), tagged };
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
  return brief.replace(HANDOFF_TAG, '').trim();
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
  updateMeta(conversationId, { salesLead: true, lastHandoffBrief: brief });
  for (const r of results) {
    addNote(conversationId, r.error
      ? `Could not send the lead to ${r.member.name || r.member.phone || r.member.email} by ${r.via}: ${r.error}`
      : `Sent to sales: ${r.member.name || ''} (${r.via === 'WhatsApp' ? r.member.phone : r.member.email})`.replace('  ', ' '));
  }
  if (!ok.length) updateMeta(conversationId, { lastHandoffAt: null }); // let it try again next time
  emit('conversation', getConversation(conversationId));
  return results;
}
