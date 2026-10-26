import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { getSetting, setSetting } from './settings.js';

const COOKIE = 'cai_session';

export function ensureAdmin() {
  if (!getSetting('admin')) {
    setSetting('admin', {
      username: config.adminUsername,
      password_hash: bcrypt.hashSync(config.adminPassword, 10),
    });
    console.log(`[auth] Created admin user "${config.adminUsername}"`);
  }
}

export function login(username, password) {
  const admin = getSetting('admin');
  if (!admin || admin.username !== username || !bcrypt.compareSync(password, admin.password_hash)) return null;
  return jwt.sign({ sub: admin.username }, config.jwtSecret, { expiresIn: '30d' });
}

export function changePassword(current, next) {
  const admin = getSetting('admin');
  if (!bcrypt.compareSync(current, admin.password_hash)) return false;
  setSetting('admin', { ...admin, password_hash: bcrypt.hashSync(next, 10) });
  return true;
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE);
}

export function readSessionCookie(cookieHeader = '') {
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

export function requireAuth(req, res, next) {
  const user = verifyToken(req.cookies?.[COOKIE]);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}
