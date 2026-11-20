'use strict';

const { createServer } = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { version } = require('./package.json');
const { isRecord, readState } = require('./telemetry');
const { createCstvSource } = require('./cstv');
const { createMapStore, imageType, mapKey, maxImageBytes } = require('./map-store');
const { createLanSharing } = require('./lan-sharing');

const publicDir = path.join(__dirname, 'public');
const loopbackHost = '127.0.0.1';
const localHosts = new Set([loopbackHost, 'localhost', '::1']);
const gsiRoutes = ['/gsi', '/'];
const maxCaptureBytes = 192 * 1024;
const gsiFields = ['provider', 'map', 'player', 'round', 'allplayers', 'phase_countdowns', 'grenades', 'allgrenades', 'bomb'];

function isGsiPost(req) {
  return req.method === 'POST' && gsiRoutes.includes(req.url?.split('?', 1)[0]);
}

async function bindLocalRadar(radar, preferred = 3000) {
  const ports = new Set([preferred, ...Array.from({ length: 11 }, (_, index) => 3000 + index)]);
  for (const port of ports) {
    try {
      return await radar.listen(port);
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Porty 3000–3010 są zajęte lub niedostępne. Zamknij poprzedni radar albo ustaw własny port.');
}

function tokenMatches(received, expected) {
  if (!expected) return true;
  if (typeof received !== 'string') return false;
  const value = Buffer.from(received);
  const token = Buffer.from(expected);
  return value.length === token.length && timingSafeEqual(value, token);
}

function createFeed() {
  let data = readState({});
  let capture;
  const listeners = new Set();
  return {
    snapshot: () => ({ ...data, sentAt: Date.now() }),
    publish(state) {
      data = state;
      for (const listener of listeners) listener();
    },
    latestCapture: () => capture && Date.now() - capture.receivedAt < 5000 ? capture.bytes : null,
    setCapture(bytes) {
      if (!bytes && !capture) return;
      capture = bytes ? { bytes, receivedAt: Date.now() } : null;
      for (const listener of listeners) listener('capture');
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
    feed.setCapture(null);
    const listener = createRadarServer({ host: ip, viewToken: token, feed, readOnly: true, maps });
    try {
      const port = await listener.listen(0);
      return { port, close: async () => {
        feed.setCapture(null);
        await listener.close();
      } };
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
  let lastCaptureAt = 0;
  let attemptedAt = 0;
  let rejection = null;
  let lastGsi = readState({});
  const cstv = canManage ? createCstvSource(feed.publish, () => feed.publish(lastGsi)) : null;

  function rejectGsi(reason) {
    attemptedAt = Date.now();
    rejection = { reason, at: attemptedAt };
  }

  function allowedHost(req) {
    if (!localOnly) return Boolean(req.headers.host);
    const port = server.address()?.port;
    const hostHeader = req.headers.host?.toLowerCase();
    const bareHost = port === 80 || (isGsiPost(req) && localHosts.has(req.socket.remoteAddress));
    return (bareHost && !hostHeader) || ['127.0.0.1', 'localhost', '[::1]']
      .some(name => hostHeader === `${name}:${port}` || (bareHost && hostHeader === name));
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

  const captureEnded = JSON.stringify({ type: 'capture-ended' });
  const unsubscribe = feed.subscribe(change => {
    if (change === 'capture' && !readOnly) return;
    const message = change === 'capture' ? feed.latestCapture() || captureEnded : JSON.stringify(feed.snapshot());
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
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    const crossSitePost = isGsiPost(req) && req.get('Sec-Fetch-Site') === 'cross-site';
    if (!sameOrigin(req) || crossSitePost) return res.sendStatus(403);
    if (!allowedHost(req)) {
      if (canManage && isGsiPost(req)) rejectGsi('host');
      return res.sendStatus(403);
    }
    next();
  });

  app.get('/api/state', (req, res) => canView(req) ? res.json(feed.snapshot()) : res.sendStatus(401));
  app.get('/health', (req, res) => {
    const state = feed.snapshot();
    res.json({
      ok: true, version, updated: state.updated, clients: wss.clients.size,
      viewTokenRequired: Boolean(viewToken), viewOnly: readOnly, manageMaps: canManage, captureAvailable: canManage,
      cstvAvailable: Boolean(cstv),
      ...(canManage ? { receiver: {
        attemptedAt, rejection, positions: state.players.length, observer: state.observer,
        map: state.map,
      } } : {}),
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

  app.put('/api/cstv', manage, express.json({ limit: '4kb', inflate: false }), (req, res) => {
    res.sendStatus(cstv.start(req.body?.url) ? 202 : 400);
  });
  app.delete('/api/cstv', manage, (req, res) => {
    cstv.stop();
    res.sendStatus(204);
  });

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

  app.put('/api/capture/frame', manage, express.raw({ type: 'image/jpeg', limit: maxCaptureBytes, inflate: false }),
    (req, res) => {
      if (!sharing.active()) return res.sendStatus(409);
      if (!Buffer.isBuffer(req.body) || imageType(req.body) !== 'image/jpeg') return res.sendStatus(415);
      const now = Date.now();
      if (now - lastCaptureAt < 70) return res.sendStatus(202);
      lastCaptureAt = now;
      feed.setCapture(req.body);
      res.sendStatus(204);
    });
  app.delete('/api/capture/frame', manage, (req, res) => {
    feed.setCapture(null);
    res.sendStatus(204);
  });

  if (readOnly) app.post(gsiRoutes, (req, res) => res.sendStatus(405));
  app.post(gsiRoutes, (req, res, next) => {
    attemptedAt = Date.now();
    next();
  }, express.json({ limit: '256kb', inflate: false, type: () => true }), (req, res) => {
    const body = req.body;
    if (!tokenMatches(body?.auth?.token, gsiToken)) {
      rejectGsi('auth');
      return res.sendStatus(401);
    }
    if (!isRecord(body) || !gsiFields.some(key => Object.hasOwn(body, key))) {
      rejectGsi('format');
      return res.status(400).json({ error: 'Brak pól GSI.' });
    }
    if (body.provider?.appid != null && String(body.provider.appid) !== '730') {
      rejectGsi('game');
      return res.status(400).json({ error: 'Nieobsługiwany identyfikator gry.' });
    }
    const now = Date.now();
    if (now - lastAccepted < 40) return res.sendStatus(202);
    lastAccepted = now;
    rejection = null;
    lastGsi = readState(body, now);
    if (!cstv?.active()) feed.publish(lastGsi);
    res.sendStatus(200);
  });

  app.use(express.static(publicDir, { dotfiles: 'ignore' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (isGsiPost(req)) rejectGsi(status === 413 ? 'size' : 'format');
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
    const capture = readOnly && feed.latestCapture();
    if (capture) client.send(capture);
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
      cstv?.stop();
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
  const requestedPort = Number(process.env.PORT || 3000);
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
    throw new Error('PORT musi być liczbą z zakresu 1–65535.');
  }
  const host = process.env.HOST || loopbackHost;
  const token = process.env.GSI_TOKEN || '';
  const radar = createRadarServer({ host, gsiToken: token, viewToken: process.env.VIEW_TOKEN });
  const useFallback = !process.env.PORT && host === loopbackHost;
  const port = await (useFallback ? bindLocalRadar(radar, requestedPort) : radar.listen(requestedPort));
  console.log(`CS2 WebRadar: http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  if (port !== requestedPort) console.log(`Port ${requestedPort} jest zajęty. Otwórz adres z portem ${port}.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => radar.close());
}

if (require.main === module) {
  startWeb().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port WebRadar jest zajęty. Ustaw inną wartość PORT.' : error.message);
    process.exitCode = 1;
  });
}

module.exports = { bindLocalRadar, createRadarServer };
