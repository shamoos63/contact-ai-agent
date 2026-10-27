import { Bot } from 'grammy';
import { getSetting } from '../settings.js';
import { handleIncoming, registerSender } from '../inbox.js';

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

  instance.on('message', (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const text = ctx.message.text || ctx.message.caption;
    if (!text) return;
    if (text === '/start') return ctx.reply('👋');
    const from = ctx.from;
    handleIncoming({
      channel: 'telegram',
      externalId: ctx.chat.id,
      name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username,
      handle: from.username ? '@' + from.username : String(from.id),
      text,
      messageId: `${ctx.chat.id}:${ctx.message.message_id}`,
    });
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
