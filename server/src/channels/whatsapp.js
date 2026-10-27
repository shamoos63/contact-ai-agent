import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import { DATA_DIR } from '../config.js';
import { getSetting } from '../settings.js';
import { handleIncoming, registerSender } from '../inbox.js';

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
      if (m.key.fromMe || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      const text = textOf(m.message);
      if (!text) continue;
      const phoneJid = m.key.senderPn || m.key.remoteJidAlt || (jid.endsWith('@s.whatsapp.net') ? jid : null);
      handleIncoming({
        channel: 'whatsapp',
        externalId: jid,
        name: m.pushName,
        handle: phoneJid ? '+' + phoneJid.split('@')[0] : jid.split('@')[0],
        text,
        messageId: m.key.id,
      });
    }
  });
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
