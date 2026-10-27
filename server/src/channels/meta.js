import crypto from 'node:crypto';
import { getSetting } from '../settings.js';
import { handleIncoming, registerSender } from '../inbox.js';

// Facebook Messenger and Instagram Direct through the official Meta Graph API.
// Meta calls our webhook (GET for verification, POST for messages). The webhook must be
// reachable from the internet, e.g. through a Cloudflare Tunnel to this server.

export function metaStatus() {
  const m = getSetting('meta');
  if (!m.enabled) return { status: 'disabled' };
  const missing = ['verify_token', 'app_secret', 'page_id', 'page_token'].filter((k) => !m[k]);
  if (missing.length) return { status: 'incomplete', missing };
  return { status: 'configured', instagram: !!m.instagram_enabled };
}

export function verifyWebhook(req, res) {
  const m = getSetting('meta');
  if (req.query['hub.mode'] === 'subscribe' && m.verify_token && req.query['hub.verify_token'] === m.verify_token) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
}

function validSignature(req, secret) {
  const header = req.get('x-hub-signature-256') || '';
  if (!secret || !header.startsWith('sha256=') || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function graph(path, { method = 'GET', body } = {}) {
  const m = getSetting('meta');
  const url = new URL(`https://graph.facebook.com/${m.graph_version}/${path}`);
  url.searchParams.set('access_token', m.page_token);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Graph API error ${res.status}`);
  return data;
}

async function lookupName(id, channel) {
  try {
    const fields = channel === 'instagram' ? 'name,username' : 'first_name,last_name';
    const p = await graph(`${id}?fields=${fields}`);
    return { name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null, handle: p.username ? '@' + p.username : null };
  } catch {
    return { name: null, handle: null };
  }
}

export async function receiveWebhook(req, res) {
  const m = getSetting('meta');
  if (!m.enabled) return res.sendStatus(404);
  if (!validSignature(req, m.app_secret)) return res.sendStatus(401);
  res.sendStatus(200); // Meta expects a fast answer; process afterwards.

  const body = req.body || {};
  const channel = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'facebook' : null;
  if (!channel || (channel === 'instagram' && !m.instagram_enabled)) return;
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const msg = event.message;
      if (!msg || msg.is_echo || !msg.text) continue;
      const senderId = event.sender?.id;
      if (!senderId || senderId === entry.id) continue;
      const profile = await lookupName(senderId, channel);
      handleIncoming({
        channel,
        accountId: entry.id,
        externalId: senderId,
        name: profile.name,
        handle: profile.handle || senderId,
        text: msg.text,
        messageId: msg.mid,
      });
    }
  }
}

async function sendViaGraph(conv, text) {
  const m = getSetting('meta');
  if (!m.enabled || !m.page_token) throw new Error('Meta integration is not configured');
  const data = await graph(`${m.page_id}/messages`, {
    method: 'POST',
    body: { recipient: { id: conv.external_id }, message: { text }, messaging_type: 'RESPONSE' },
  });
  return { externalId: data.message_id };
}

registerSender('facebook', sendViaGraph);
registerSender('instagram', sendViaGraph);
