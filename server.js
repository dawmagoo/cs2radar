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
const { createMapStore, mapKey, maxImageBytes } = require('./map-store');
const { createLanSharing } = require('./lan-sharing');

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

function createRadarServer({
  host = loopbackHost, gsiToken = '', viewToken = '', feed = createFeed(), readOnly = false,
  maps = createMapStore(), lanAddresses,
} = {}) {
  if (readOnly && !viewToken) throw new Error('Podgląd wymaga tokenu.');
  if (!localHosts.has(host) && !readOnly && (!gsiToken || !viewToken || gsiToken === viewToken)) {
    throw new Error('Tryb LAN wymaga dwóch różnych wartości GSI_TOKEN i VIEW_TOKEN.');
  }
  const localOnly = localHosts.has(host);
  const canManage = localOnly && !readOnly;
  const sharing = canManage ? createLanSharing(async (ip, token) => {
    const listener = createRadarServer({ host: ip, viewToken: token, feed, readOnly: true, maps });
    try {
      const port = await listener.listen(0);
      return { port, close: listener.close };
    } catch (error) {
      await listener.close();
      throw error;
    }
  }, lanAddresses) : null;
  const app = express();
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 4_000 }, app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_048 });
  let lastAccepted = 0;
  let closing;
  let rejectedAuthAt = 0;

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
  app.get('/health', (req, res) => {
    const state = feed.snapshot();
    res.json({
      ok: true, version, updated: state.updated, clients: wss.clients.size,
      viewTokenRequired: Boolean(viewToken), viewOnly: readOnly, manageMaps: canManage,
      ...(canManage ? { receiver: { rejectedAuthAt, positions: state.players.length, observer: state.observer } } : {}),
    });
  });

  function manage(req, res, next) {
    if (!canManage || req.get('X-WebRadar-Local') !== '1' || !canView(req)) return res.sendStatus(403);
    next();
  }

  function allowViewer(req, res, next) {
    if (!canView(req)) return res.sendStatus(401);
    next();
  }

  function asyncRoute(action) {
    return (req, res, next) => action(req, res).catch(next);
  }

  app.get('/api/share', manage, (req, res) => res.json(sharing.status()));
  app.put('/api/share', manage, express.json({ limit: '1kb' }), asyncRoute(async (req, res) => {
    res.json(await sharing.start(req.body?.ip));
  }));
  app.delete('/api/share', manage, asyncRoute(async (req, res) => res.json(await sharing.stop())));

  function checkedMap(req, res, next) {
    res.locals.mapKey = mapKey(req.params.map, req.params.floor);
    if (!res.locals.mapKey) return res.sendStatus(404);
    next();
  }

  const mapRoute = '/api/maps/:map/:floor';
  app.get(mapRoute, allowViewer, checkedMap, asyncRoute(async (req, res) => res.json(await maps.info(res.locals.mapKey))));
  app.get(`${mapRoute}/image`, allowViewer, checkedMap, asyncRoute(async (req, res) => {
    const image = await maps.readImage(res.locals.mapKey);
    if (!image) return res.sendStatus(404);
    res.set('ETag', `"${image.etag}"`).type(image.type).send(image.bytes);
  }));
  app.put(`${mapRoute}/image`, manage, checkedMap,
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: maxImageBytes, inflate: false }),
    asyncRoute(async (req, res) => {
      const type = req.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      res.sendStatus(await maps.writeImage(res.locals.mapKey, req.body, type) ? 204 : 415);
    }));
  app.put(`${mapRoute}/bounds`, manage, checkedMap, express.json({ limit: '1kb' }), asyncRoute(async (req, res) => {
    res.sendStatus(await maps.writeBounds(res.locals.mapKey, req.body) ? 204 : 400);
  }));
  app.delete(`${mapRoute}/image`, manage, checkedMap, asyncRoute(async (req, res) => {
    await maps.removeImage(res.locals.mapKey);
    res.sendStatus(204);
  }));
  app.delete(`${mapRoute}/bounds`, manage, checkedMap, asyncRoute(async (req, res) => {
    await maps.removeBounds(res.locals.mapKey);
    res.sendStatus(204);
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
    if (!tokenMatches(body?.auth?.token, gsiToken)) {
      rejectedAuthAt = Date.now();
      return res.sendStatus(401);
    }
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

  const waitingForPong = new Set();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (waitingForPong.has(client)) client.terminate();
      else if (client.readyState === WebSocket.OPEN) {
        waitingForPong.add(client);
        client.ping();
      }
    }
  }, 15_000).unref();

  wss.on('connection', client => {
    client.on('error', () => {});
    client.on('pong', () => waitingForPong.delete(client));
    client.on('close', () => waitingForPong.delete(client));
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
    closing ??= Promise.all([sharing?.dispose(), new Promise(resolve => {
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(resolve);
      server.closeAllConnections();
    })]);
    return closing;
  }

  return { listen, close, feed, sharing };
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
