import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { config } from './config.js';
import { ensureAdmin, readSessionCookie, verifyToken } from './auth.js';
import { setIo } from './realtime.js';
import { api } from './routes/api.js';
import { verifyWebhook, receiveWebhook } from './channels/meta.js';
import { startChannels, stopChannels } from './channels/index.js';
import { ensureModels } from './ai/ollama.js';

ensureAdmin();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb', verify: (req, res, buf) => (req.rawBody = buf) }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/webhooks/meta', verifyWebhook);
app.post('/webhooks/meta', receiveWebhook);
app.use('/api', api);

if (fs.existsSync(config.clientDir)) {
  app.use(express.static(config.clientDir));
  app.get(/^(?!\/(api|webhooks|socket\.io)\/).*/, (req, res) => res.sendFile(path.join(config.clientDir, 'index.html')));
}

const server = http.createServer(app);
const io = new Server(server);
io.use((socket, next) => {
  const user = verifyToken(readSessionCookie(socket.handshake.headers.cookie));
  if (!user) return next(new Error('unauthorized'));
  next();
});
setIo(io);

server.listen(config.port, () => {
  console.log(`[server] Dashboard on http://localhost:${config.port}`);
  startChannels();
  ensureModels();
});

async function shutdown() {
  console.log('[server] Shutting down...');
  await stopChannels();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
