'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { get } = require('node:http');
const { createServer } = require('node:net');
const { test } = require('node:test');
const { setTimeout } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { createRadarServer } = require('../server');

test('the server can bind a different port after a collision', async t => {
  const blocker = createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const radar = createRadarServer();
  t.after(() => radar.close());

  await assert.rejects(radar.listen(blocker.address().port), { code: 'EADDRINUSE' });
  const port = await radar.listen(0);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal((await health.json()).ok, true);
});

test('GSI updates the browser without requiring a position in every update', async t => {
  const radar = createRadarServer({ gsiToken: 'game-fixture', viewToken: 'preview-fixture' });
  t.after(() => radar.close());
  const port = await radar.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=preview-fixture`, { origin: base });
  const read = async () => {
    const [data] = await once(ws, 'message');
    return JSON.parse(data);
  };
  const post = (body, headers = {}) => fetch(`${base}/gsi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  assert.equal((await read()).source, 'waiting');
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await post({ player: { name: 'No token' } })).status, 401);
  assert.equal((await post({ auth: { token: 'game-fixture' } })).status, 400);
  assert.equal((await post({ map: {} }, { origin: 'https://example.test' })).status, 403);
  const update = read();
  assert.equal((await post({
    auth: { token: 'game-fixture' },
    provider: { appid: 730 },
    map: { name: 'de_nuke', round: 4, team_ct: { score: 3 }, team_t: { score: 1 } },
    player: { name: 'Tester', position: '10.1, -20, -500', forward: '0, 1, 0', state: { health: 104 } },
  })).status, 200);
  const state = await update;
  assert.equal(state.map, 'de_nuke');
  assert.deepEqual(state.score, { ct: 3, t: 1 });
  assert.equal(state.players[0].z, -500);
  assert.equal(state.player.angle, 90);
  assert.equal(state.player.hp, 100);

  await setTimeout(45);
  const withoutPosition = read();
  assert.equal((await post({
    auth: { token: 'game-fixture' },
    player: { name: 'Tester', position: ', -20, 0', state: { health: 42 } },
  })).status, 200);
  const next = await withoutPosition;
  assert.equal(next.map, 'unknown');
  assert.deepEqual(next.players, []);
  assert.equal(next.player.hp, 42);
  assert.equal(next.player.x, null);
});

test('invalid websocket origins and host headers are rejected without stopping the server', async t => {
  assert.throws(() => createRadarServer({ host: '0.0.0.0', gsiToken: 'same', viewToken: 'same' }), /LAN/);
  const radar = createRadarServer();
  t.after(() => radar.close());
  const port = await radar.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'null' });
  await assert.rejects(once(ws, 'open'), /403/);
  const wrongHost = await new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: '/health', headers: { host: `external.test:${port}` } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  const download = await fetch(`http://127.0.0.1:${port}/api/gsi-config`);
  assert.match(await download.text(), new RegExp(`127\\.0\\.0\\.1:${port}/gsi`));
});

test('authenticated LAN preview gets the official observer feed and rejects writes', async t => {
  const radar = createRadarServer({ gsiToken: 'fixture' });
  t.after(() => radar.close());
  const incomingPort = await radar.listen(0);
  const lan = createRadarServer({ feed: radar.feed, viewToken: 'lan-fixture', readOnly: true });
  t.after(() => lan.close());
  const lanPort = await lan.listen(0);
  const lanUrl = `http://127.0.0.1:${lanPort}`;
  const ws = new WebSocket(`ws://127.0.0.1:${lanPort}/ws?token=lan-fixture`, { origin: lanUrl });
  await once(ws, 'message');

  assert.equal((await fetch(`${lanUrl}/health`).then(response => response.json())).viewOnly, true);
  assert.equal((await fetch(`${lanUrl}/api/state`)).status, 401);
  assert.equal((await fetch(`${lanUrl}/api/gsi-config`)).status, 404);
  assert.equal((await fetch(`${lanUrl}/gsi`, { method: 'POST' })).status, 405);

  const update = once(ws, 'message');
  const response = await fetch(`http://127.0.0.1:${incomingPort}/gsi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auth: { token: 'fixture' },
      map: { name: 'de_mirage', round: 1 },
      player: { steamid: 'observer-a' },
      allplayers: {
        'observer-a': { name: 'CT gracz', team: 'CT', state: { armor: 100, health: 50, money: 4000 },
          position: '100.75, .5, 45', weapons: { weapon_0: { state: 'active', name: 'weapon_m4a1', ammo_clip: 14 },
            weapon_1: { state: 'holstered', name: 'weapon_smokegrenade', type: 'Grenade', ammo_reserve: 1 } } },
        'observer-b': { name: 'T gracz', team: 'T', match_stats: { kills: 4 } },
      },
      grenades: { 'grenade-a': { type: 'smoke', position: '3, 4, 5', effecttime: '3.5' } },
      bomb: { state: 'planted', position: '3, 5, 5', countdown: '22.2' },
      phase_countdowns: { phase: 'bomb', phase_ends_in: '22.2' },
    }),
  });
  assert.equal(response.status, 200);
  const [message] = await update;
  const state = JSON.parse(message);
  assert.equal(state.observer, true);
  assert.equal(state.roster.length, 2);
  assert.equal(state.players.length, 1);
  assert.equal(state.player.name, 'CT gracz');
  assert.equal(state.player.ammo, 14);
  assert.equal(state.player.money, 4000);
  assert.equal(state.grenades[0].type, 'smoke');
  assert.equal(state.bomb.remaining, 22.2);
  assert.equal(state.remaining, 22.2);
  assert.equal(JSON.stringify(state).includes('observer-a'), false);
  const [closed] = await Promise.all([once(ws, 'close'), lan.close()]);
  assert.ok(closed.length);
  assert.equal((await fetch(`http://127.0.0.1:${incomingPort}/health`)).status, 200);
});

test('the GSI receiver reports rejected packets and accepts JSON from a loopback game client', async t => {
  const radar = createRadarServer({ gsiToken: 'game-fixture' });
  t.after(() => radar.close());
  const port = await radar.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const send = (body, contentType, requestPath = '/gsi') => new Promise((resolve, reject) => {
    const input = Buffer.from(body);
    const request = require('node:http').request({
      host: '127.0.0.1', port, path: requestPath, method: 'POST',
      headers: {
        host: '127.0.0.1',
        'content-length': input.length,
        ...(contentType && { 'content-type': contentType }),
      },
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end(input);
  });
  const health = () => fetch(`${base}/health`).then(response => response.json());

  assert.equal((await health()).receiver.attemptedAt, 0);
  assert.equal(await send('invalid JSON', 'text/plain'), 400);
  assert.equal((await health()).receiver.rejection.reason, 'format');
  assert.equal(await send(JSON.stringify({ provider: { appid: 730 } }), 'application/json'), 401);
  assert.equal((await health()).receiver.rejection.reason, 'auth');
  assert.equal((await health()).updated, 0);
  const packet = { auth: { token: 'game-fixture' }, provider: { appid: 730 }, map: { name: 'de_mirage' } };
  assert.equal(await send(JSON.stringify(packet), 'text/plain; charset=utf-8'), 200);
  const accepted = await health();
  assert.equal(accepted.receiver.rejection, null);
  assert.equal(accepted.receiver.map, 'de_mirage');
  assert.ok(accepted.updated > 0);

  await setTimeout(50);
  assert.equal(await send(JSON.stringify(packet), undefined, '/'), 200);
});
