import path from 'node:path';
import { Bot } from 'grammy';
import { getSetting } from '../settings.js';
import { handleIncoming, registerSender } from '../inbox.js';
import { handleVoiceNote } from '../voice.js';

let bot = null;
let state = { status: 'disabled', username: null, error: null };

export function telegramStatus() {
  return state;
}

export async function startTelegram(onChange) {
  await stopTelegram();
  const { enabled, token } = getSetting('telegram');
  if (!enabled || !token) {
    state = { status: 'disabled', username: null, error: null };
    return onChange?.();
  }
  state = { status: 'connecting', username: null, error: null };
  onChange?.();
  const instance = new Bot(token);
  bot = instance;

  instance.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const from = ctx.from;
    const sender = {
      channel: 'telegram',
      externalId: ctx.chat.id,
      name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username,
      handle: from.username ? '@' + from.username : String(from.id),
      messageId: `${ctx.chat.id}:${ctx.message.message_id}`,
    };
    const voice = ctx.message.voice || ctx.message.audio;
    if (voice) {
      // Not awaited: transcribing can take a while and must not hold up other chats.
      (async () => {
        const file = await ctx.getFile();
        const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const ext = path.extname(file.file_path || '').slice(1) || 'ogg';
        await handleVoiceNote({ ...sender, buffer: Buffer.from(await res.arrayBuffer()), ext, duration: voice.duration });
      })().catch((err) => console.error('[telegram] Voice note failed:', err.message));
      return;
    }
    const text = ctx.message.text || ctx.message.caption;
    if (!text) return;
    if (text === '/start') return ctx.reply('👋');
    handleIncoming({ ...sender, text });
  });
  instance.catch((err) => console.error('[telegram]', err.message));

  try {
    await instance.init();
    state = { status: 'connected', username: instance.botInfo.username, error: null };
    onChange?.();
    instance.start({ drop_pending_updates: false }).catch((err) => {
      if (bot !== instance) return;
      state = { status: 'error', username: null, error: err.message };
      onChange?.();
    });
  } catch (err) {
    bot = null;
    state = { status: 'error', username: null, error: err.message };
    onChange?.();
  }
}

export async function stopTelegram() {
  const old = bot;
  bot = null;
  if (old?.isRunning()) await old.stop().catch(() => {});
}

registerSender('telegram', async (conv, text) => {
  if (!bot) throw new Error('Telegram bot is not running');
  const sent = await bot.api.sendMessage(conv.external_id, text);
  return { externalId: `${conv.external_id}:${sent.message_id}` };
});
