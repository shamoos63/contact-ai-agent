// Models write Markdown (### headings, **bold**, [links](url)); chat apps show it as raw symbols.
// WhatsApp has its own: *bold*, _italic_. Telegram messages are sent as plain text.
export function forChat(text, channel = 'whatsapp') {
  const bold = channel === 'whatsapp' ? (s) => `*${s}*` : (s) => s;
  return String(text ?? '')
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, h) => bold(h.replace(/\*\*/g, '')))
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, (_, b) => bold(b))
    .replace(/__(?=\S)([^_\n]+?)__/g, (_, b) => bold(b))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => (t === u ? u : `${t}: ${u}`))
    .replace(/^\s*[*+]\s+/gm, '• ')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
