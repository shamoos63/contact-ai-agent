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
  whatsapp: { label: 'WhatsApp', color: '#25d366', short: 'WA' },
  telegram: { label: 'Telegram', color: '#229ed9', short: 'TG' },
  email: { label: 'Email', color: '#ea4335', short: '@' },
  facebook: { label: 'Facebook', color: '#1877f2', short: 'FB' },
  instagram: { label: 'Instagram', color: '#e1306c', short: 'IG' },
};

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function initials(name = '') {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

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
