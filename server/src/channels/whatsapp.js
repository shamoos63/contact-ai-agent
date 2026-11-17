import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
import { DATA_DIR } from '../config.js';
import { getSetting } from '../settings.js';
import { handleIncoming, registerSender, registerVoiceSender, registerImageSender, registerPresence } from '../inbox.js';
import { handleVoiceNote, handleImage } from '../voice.js';
import { isTeamNumber, registerWhatsAppSender } from '../handoff.js';

const AUTH_DIR = path.join(DATA_DIR, 'whatsapp-auth');
const logger = pino({ level: 'silent' });

let sock = null;
let generation = 0;
let state = { status: 'disabled', qr: null, me: null, error: null };
let notify = () => {};

export function whatsappStatus() {
  return state;
}

function setState(patch) {
  state = { ...state, ...patch };
  notify();
}

function textOf(message) {
  if (!message) return null;
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    null
  );
}

// --- Groups ---
// In a group the AI answers only when it's addressed (mentioned, replied to, or called by name),
// unless the owner set it to answer everything. Each group is one chat in the inbox, and every
// message there starts with the sender's name so the AI knows who said what.
const groupNames = new Map(); // jid -> { subject, at }
async function groupSubject(socket, jid) {
  const cached = groupNames.get(jid);
  if (cached && Date.now() - cached.at < 3600e3) return cached.subject;
  try {
    const meta = await socket.groupMetadata(jid);
    groupNames.set(jid, { subject: meta.subject, at: Date.now() });
    return meta.subject;
  } catch {
    return cached?.subject || 'WhatsApp group';
  }
}
const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function groupSettings() {
  const w = getSetting('whatsapp');
  return { mode: w.groups || 'mention', names: String(w.group_names || '') };
}

// Is this group message for the AI? me: our own ids (phone and LID digits).
export function addressedInGroup({ text = '', mentioned = [], quotedFrom = null }, me, { mode, names }) {
  if (mode === 'all') return true;
  const mine = new Set(me.filter(Boolean).map(digitsOf));
  if (mentioned.some((j) => mine.has(digitsOf(j)))) return true;
  if (quotedFrom && mine.has(digitsOf(quotedFrom))) return true;
  const words = [...names.split(/[,،\n]/), getSetting('company_name')].map((w) => w.trim()).filter((w) => w.length >= 2 && w !== 'Our Company');
  return words.some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
}

export async function startWhatsApp(onChange) {
  if (onChange) notify = onChange;
  await stopWhatsApp();
  if (!getSetting('whatsapp').enabled) return setState({ status: 'disabled', qr: null, me: null, error: null });
  const myGeneration = ++generation;
  setState({ status: 'connecting', qr: null, error: null });

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    // Fall back to the version bundled with Baileys.
  }
  const socket = makeWASocket({
    auth: authState,
    version,
    logger,
    browser: Browsers.appropriate('Contact AI Agent'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = socket;

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (myGeneration !== generation) return;
    if (qr) setState({ status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 300 }) });
    if (connection === 'open') {
      setState({ status: 'connected', qr: null, me: socket.user?.name || socket.user?.id?.split(':')[0] || null });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setState({ status: 'logged_out', qr: null, me: null, error: 'Logged out from the phone. Scan the QR again.' });
        setTimeout(() => myGeneration === generation && startWhatsApp(), 1000);
      } else {
        setState({ status: 'connecting', error: lastDisconnect?.error?.message || null });
        setTimeout(() => myGeneration === generation && startWhatsApp(), 3000);
      }
    }
  });

  socket.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (m.key.fromMe || !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      if (jid.endsWith('@g.us')) {
        handleGroupMessage(socket, m).catch((err) => console.error('[whatsapp] Group message failed:', err.message));
        continue;
      }
      const phoneJid = m.key.senderPn || m.key.remoteJidAlt || (jid.endsWith('@s.whatsapp.net') ? jid : null);
      const phone = phoneJid ? '+' + phoneJid.split('@')[0] : null;
      const sender = {
        channel: 'whatsapp',
        externalId: jid,
        name: m.pushName,
        handle: phone || jid.split('@')[0],
        messageId: m.key.id,
        convMeta: phone ? { phone } : undefined,
        // Messages from our own sales team land in the inbox but the AI doesn't answer them.
        autoReply: !isTeamNumber(phone),
      };
      const inner = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message;
      const audio = inner?.audioMessage;
      if (audio) {
        // Not awaited: transcribing can take a while and must not hold up other chats.
        downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
          .then((buffer) => handleVoiceNote({ ...sender, buffer, ext: 'ogg', duration: audio.seconds }))
          .catch((err) => console.error('[whatsapp] Voice note failed:', err.message));
        continue;
      }
      // A photo, or a picture sent as a file.
      const picture = inner?.imageMessage || (inner?.documentMessage?.mimetype?.startsWith('image/') ? inner.documentMessage : null);
      if (picture) {
        downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
          .then((buffer) => handleImage({ ...sender, buffer, caption: picture.caption || '' }))
          .catch((err) => console.error('[whatsapp] Photo failed:', err.message));
        continue;
      }
      const text = textOf(m.message);
      if (!text) continue;
      handleIncoming({ ...sender, text });
    }
  });
}

async function handleGroupMessage(socket, m) {
  const g = groupSettings();
  if (g.mode === 'off') return;
  const jid = m.key.remoteJid;
  const inner = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message;
  if (!inner) return;
  const ctx = Object.values(inner).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo || {};
  const raw = textOf(m.message) || '';
  const me = [socket.user?.id, socket.user?.lid];
  const addressed = addressedInGroup({ text: raw, mentioned: ctx.mentionedJid || [], quotedFrom: ctx.participant || null }, me, g);
  const who = m.key.participantPn || m.key.participantAlt || m.key.participant || '';
  const phone = who.endsWith('@s.whatsapp.net') ? `+${digitsOf(who)}` : null;
  const name = m.pushName || phone || 'Someone';
  // Our own @mention reads as a number: take it out.
  const mine = me.filter(Boolean).map(digitsOf);
  const said = mine.reduce((t, d) => t.replace(new RegExp(`@${d}\\b`, 'g'), ''), raw).replace(/\s{2,}/g, ' ').trim();
  const sender = {
    channel: 'whatsapp',
    externalId: jid,
    name: await groupSubject(socket, jid),
    handle: 'group',
    messageId: m.key.id,
    convMeta: { group: true },
    autoReply: addressed,
  };
  const audio = inner.audioMessage;
  const picture = inner.imageMessage || (inner.documentMessage?.mimetype?.startsWith('image/') ? inner.documentMessage : null);
  // Voice notes and photos take a while to read: only the ones meant for the AI.
  if ((audio || picture) && !addressed) return;
  if (audio) {
    const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage });
    return handleVoiceNote({ ...sender, buffer, ext: 'ogg', duration: audio.seconds, speaker: name });
  }
  if (picture) {
    const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage });
    return handleImage({ ...sender, buffer, caption: `${name}: ${said}`.replace(/:\s*$/, ':') });
  }
  if (!said) return;
  handleIncoming({ ...sender, text: `${name}: ${said}`, meta: { group: true, from: name, ...(phone ? { phone } : {}) } });
}

// Send a WhatsApp message to any number, e.g. a lead brief to a sales team member.
export async function sendWhatsAppTo(phone, text) {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not connected');
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 7) throw new Error(`"${phone}" is not a valid phone number`);
  await sock.sendMessage(`${digits}@s.whatsapp.net`, { text });
}

export function whatsappConnected() {
  return !!sock && state.status === 'connected';
}

export async function stopWhatsApp() {
  generation++;
  const old = sock;
  sock = null;
  if (old) {
    old.ev.removeAllListeners();
    old.end(undefined);
  }
}

export async function logoutWhatsApp() {
  try {
    await sock?.logout();
  } catch {
    // Already disconnected.
  }
  await stopWhatsApp();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  setState({ status: 'logged_out', qr: null, me: null, error: null });
  if (getSetting('whatsapp').enabled) startWhatsApp();
}

registerSender('whatsapp', async (conv, text) => {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not connected');
  const sent = await sock.sendMessage(conv.external_id, { text });
  return { externalId: sent?.key?.id };
});

registerVoiceSender('whatsapp', async (conv, audio) => {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not connected');
  const sent = await sock.sendMessage(conv.external_id, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  return { externalId: sent?.key?.id };
});

registerImageSender('whatsapp', async (conv, image, caption) => {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not connected');
  const sent = await sock.sendMessage(conv.external_id, { image, caption: caption || undefined });
  return { externalId: sent?.key?.id };
});

// "typing…" / "recording audio…". WhatsApp shows it for about 25 seconds, so it's renewed every 10.
const subscribed = new Set();
registerPresence('whatsapp', async (jid, kind) => {
  if (!sock || state.status !== 'connected') return;
  if (!subscribed.has(jid)) {
    subscribed.add(jid);
    await sock.presenceSubscribe(jid).catch(() => {});
  }
  await sock.sendPresenceUpdate(kind === 'recording' ? 'recording' : kind === 'paused' ? 'paused' : 'composing', jid);
}, 10000);

registerWhatsAppSender(sendWhatsAppTo);
