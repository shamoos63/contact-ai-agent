import { io } from 'socket.io-client';

export async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('logged-out'));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let socket = null;
export function getSocket() {
  if (!socket) socket = io({ withCredentials: true });
  return socket;
}
export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

export const CHANNELS = {
  whatsapp: { label: 'WhatsApp', color: '#25d366', icon: '🟢' },
  telegram: { label: 'Telegram', color: '#229ed9', icon: '✈️' },
  email: { label: 'Email', color: '#ea4335', icon: '✉️' },
  facebook: { label: 'Facebook', color: '#1877f2', icon: '📘' },
  instagram: { label: 'Instagram', color: '#e1306c', icon: '📸' },
};

export function timeAgo(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return d.toLocaleDateString();
}

export function formatTime(sqlDate) {
  if (!sqlDate) return '';
  return new Date(sqlDate.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}
