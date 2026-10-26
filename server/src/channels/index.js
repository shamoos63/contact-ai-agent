import { emit } from '../realtime.js';
import { startTelegram, stopTelegram, telegramStatus } from './telegram.js';
import { startWhatsApp, stopWhatsApp, whatsappStatus } from './whatsapp.js';
import { startEmail, stopEmail, listAccounts } from './email.js';
import { metaStatus } from './meta.js';

export function channelStatus() {
  return {
    whatsapp: whatsappStatus(),
    telegram: telegramStatus(),
    email: listAccounts(),
    meta: metaStatus(),
  };
}

const push = () => emit('channels', channelStatus());

export const restart = {
  telegram: () => startTelegram(push),
  whatsapp: () => startWhatsApp(push),
  email: () => startEmail(push),
};

export async function startChannels() {
  for (const [name, start] of Object.entries(restart)) {
    start().catch((err) => console.error(`[${name}] Failed to start:`, err.message));
  }
}

export async function stopChannels() {
  await Promise.allSettled([stopTelegram(), stopWhatsApp(), stopEmail()]);
}
