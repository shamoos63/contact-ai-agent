import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { getSetting } from './settings.js';

// Nightly backup of what can't be downloaded again: the database (chats, knowledge, settings,
// tasks, contacts) and the WhatsApp login, into data/backups/<date>. Models, voices and media
// are left out (they are big and can be downloaded or are not essential).

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort()
    .reverse()
    .map((name) => {
      const dir = path.join(BACKUP_DIR, name);
      const size = fs.readdirSync(dir, { recursive: true }).reduce((s, f) => {
        const st = fs.statSync(path.join(dir, String(f)));
        return s + (st.isFile() ? st.size : 0);
      }, 0);
      return { name, size, at: fs.statSync(dir).mtime.toISOString() };
    });
}

let running = null;
export function backupNow(label = new Date().toISOString().slice(0, 10)) {
  if (running) return running;
  running = (async () => {
    const dir = path.join(BACKUP_DIR, label);
    const tmp = `${dir}.part`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await db.backup(path.join(tmp, 'agent.db')); // safe while the app is running
    const auth = path.join(DATA_DIR, 'whatsapp-auth');
    if (fs.existsSync(auth)) fs.cpSync(auth, path.join(tmp, 'whatsapp-auth'), { recursive: true });
    for (const f of ['.jwt-secret']) if (fs.existsSync(path.join(DATA_DIR, f))) fs.copyFileSync(path.join(DATA_DIR, f), path.join(tmp, f));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    const keep = Math.max(1, Number(getSetting('backup').keep) || 7);
    for (const old of listBackups().slice(keep)) fs.rmSync(path.join(BACKUP_DIR, old.name), { recursive: true, force: true });
    console.log(`[backup] Saved ${dir}`);
    return listBackups()[0];
  })().finally(() => { running = null; });
  return running;
}

// Once a day after the chosen time (server local time is UTC in Docker, so it uses the assistant's time zone).
let timer = null;
export function startBackups(timeZone = () => 'UTC') {
  clearInterval(timer);
  const tick = () => {
    const s = getSetting('backup');
    if (!s.enabled) return;
    let tz = 'UTC';
    try { tz = timeZone() || 'UTC'; } catch { /* keep UTC */ }
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map((p) => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (`${parts.hour}:${parts.minute}` < (s.time || '03:00')) return;
    if (listBackups().some((b) => b.name === today)) return;
    backupNow(today).catch((err) => console.error('[backup] Failed:', err.message));
  };
  timer = setInterval(tick, 5 * 60e3);
  timer.unref?.();
  setTimeout(tick, 30e3).unref?.();
}
