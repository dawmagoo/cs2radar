'use strict';

const { createServer } = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { renderGsiConfig } = require('./steam');
const { version } = require('./package.json');
const { isRecord, readState } = require('./telemetry');

const publicDir = path.join(__dirname, 'public');
const loopbackHost = '127.0.0.1';
const localHosts = new Set([loopbackHost, 'localhost', '::1']);

function tokenMatches(received, expected) {
  if (!expected) return true;
  if (typeof received !== 'string') return false;
  const value = Buffer.from(received);
  const token = Buffer.from(expected);
  return value.length === token.length && timingSafeEqual(value, token);
}

function createFeed() {
  let data = readState({});
  const listeners = new Set();
  return {
    snapshot: () => ({ ...data, sentAt: Date.now() }),
    publish(state) {
      data = state;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createRadarServer({ host = loopbackHost, gsiToken = '', viewToken = '', feed = createFeed(), readOnly = false } = {}) {
  if (readOnly && !viewToken) throw new Error('Podgląd wymaga tokenu.');
  if (!localHosts.has(host) && !readOnly && (!gsiToken || !viewToken || gsiToken === viewToken)) {
    throw new Error('Tryb LAN wymaga dwóch różnych wartości GSI_TOKEN i VIEW_TOKEN.');
  }
  const localOnly = localHosts.has(host);
  const app = express();
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 4_000 }, app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_048 });
  let lastAccepted = 0;
  let closing;

  function allowedHost(req) {
    if (!localOnly) return Boolean(req.headers.host);
    const port = server.address()?.port;
    const hostHeader = req.headers.host?.toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]'].some(name => hostHeader === `${name}:${port}` || (port === 80 && hostHeader === name));
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  }

  function canView(req) {
    if (!viewToken) return true;
    const query = req.url.slice(req.url.indexOf('?') + 1);
    return tokenMatches(req.headers['x-view-token'] || new URLSearchParams(query).get('token'), viewToken);
  }

  const unsubscribe = feed.subscribe(() => {
    const message = JSON.stringify(feed.snapshot());
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 65_536) client.send(message);
    }
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    if (!allowedHost(req) || !sameOrigin(req)) return res.sendStatus(403);
    next();
  });

  app.get('/api/state', (req, res) => canView(req) ? res.json(feed.snapshot()) : res.sendStatus(401));
  app.get('/health', (req, res) => res.json({
    ok: true, version, updated: feed.snapshot().updated, clients: wss.clients.size, viewTokenRequired: Boolean(viewToken), viewOnly: readOnly,
  }));

  app.get('/api/map-images', (req, res) => {
    const names = readdirSync(path.join(publicDir, 'maps'));
    res.json(names.filter(name => /^[a-z0-9_-]+\.png$/i.test(name)));
  });

  app.get('/api/gsi-config', (req, res) => {
    if (readOnly) return res.sendStatus(404);
    res.attachment('gamestate_integration_webradar.cfg')
      .type('text/plain')
      .send(renderGsiConfig(server.address().port));
  });

  if (readOnly) app.post('/gsi', (req, res) => res.sendStatus(405));
  app.post('/gsi', express.json({ limit: '256kb', inflate: false }), (req, res) => {
    if (!req.is('application/json')) return res.sendStatus(415);
    const body = req.body;
    if (!tokenMatches(body?.auth?.token, gsiToken)) return res.sendStatus(401);
    if (!isRecord(body) || !['provider', 'map', 'player', 'round', 'allplayers', 'phase_countdowns', 'grenades', 'bomb'].some(key => Object.hasOwn(body, key))) {
      return res.status(400).json({ error: 'Brak pól GSI.' });
    }
    if (body.provider?.appid != null && String(body.provider.appid) !== '730') {
      return res.status(400).json({ error: 'Nieobsługiwany identyfikator gry.' });
    }
    const now = Date.now();
    if (now - lastAccepted < 40) return res.sendStatus(202);
    lastAccepted = now;
    feed.publish(readState(body, now));
    res.sendStatus(200);
  });

  app.use(express.static(publicDir, { dotfiles: 'ignore' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Błąd serwera.' : 'Nieprawidłowe żądanie.' });
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws' || !allowedHost(req) || !sameOrigin(req) || !canView(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
  });

  wss.on('connection', client => {
    client.on('error', () => {});
    client.send(JSON.stringify(feed.snapshot()));
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host, port, exclusive: true });
    });
  }

  function close() {
    closing ??= new Promise(resolve => {
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(resolve);
      server.closeAllConnections();
    });
    return closing;
  }

  return { listen, close, feed };
}

async function startWeb() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT musi być liczbą z zakresu 1–65535.');
  const host = process.env.HOST || loopbackHost;
  const radar = createRadarServer({ host, gsiToken: process.env.GSI_TOKEN, viewToken: process.env.VIEW_TOKEN });
  await radar.listen(port);
  console.log(`CS2 WebRadar: http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => radar.close());
}

if (require.main === module) {
  startWeb().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port WebRadar jest zajęty. Ustaw inną wartość PORT.' : error.message);
    process.exitCode = 1;
  });
}

module.exports = { createRadarServer };
