'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { createRadarServer } = require('../server');

function tickFrame(tick) {
  const frame = Buffer.alloc(10);
  frame[0] = 3;
  frame.writeUInt32LE(tick, 1);
  return frame;
}

async function waitForState(base, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await fetch(`${base}/api/state`).then(response => response.json());
    if (predicate(state)) return state;
    await sleep(20);
  }
  assert.fail('Radar did not publish the expected state');
}

test('an HTTP CSTV source selects its own map and publishes observer positions to an authorized viewer', async t => {
  const { DemoReader } = await import('cs2parser');
  t.mock.getter(DemoReader.prototype, 'playerControllers', () => [
    { name: 'Strażnik', steamId: '76561190000000001', teamNumber: 3, isConnected: true,
      isAlive: true, position: { x: -1500, y: 500, z: -450 }, pawn: {},
      eyeAngles: { yaw: 90 }, health: 87, money: 700 },
    { name: 'Napastnik', steamId: '76561190000000002', teamNumber: 2, isConnected: true,
      isAlive: true, position: { x: -1100, y: 100, z: -420 }, pawn: {},
      eyeAngles: { yaw: 0 }, health: 54, money: 3500 },
    { name: 'Polegli', entityId: 5, teamNumber: 2, isConnected: true, isAlive: false, pawn: {}, health: 0 },
    { name: 'CSTV', entityId: 6, teamNumber: 1, isConnected: true, isHLTV: true },
  ]);
  t.mock.getter(DemoReader.prototype, 'teams', () => [
    { teamNumber: 2, score: 4 }, { teamNumber: 3, score: 6 },
  ]);
  const requests = [];
  const relay = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/match/sync') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        tick: 65, rtdelay: 0, rcvage: 0, fragment: 1, signup_fragment: 0, tps: 64, protocol: 5, map: 'de_nuke',
      }));
    } else if (req.url === '/match/0/start') res.end();
    else if (req.url === '/match/1/full') res.end(tickFrame(65));
    else if (req.url === '/match/1/delta') res.end(Buffer.concat([tickFrame(73), tickFrame(81), tickFrame(89)]));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const url = `http://127.0.0.1:${relay.address().port}/match`;
  const radar = createRadarServer();
  const port = await radar.listen(0);
  t.after(() => radar.close());
  const base = `http://127.0.0.1:${port}`;
  const viewer = createRadarServer({ feed: radar.feed, readOnly: true, viewToken: 'test-viewer' });
  const viewerPort = await viewer.listen(0);
  t.after(() => viewer.close());
  const ws = new WebSocket(`ws://127.0.0.1:${viewerPort}/ws?token=test-viewer`);
  assert.equal(JSON.parse((await once(ws, 'message'))[0]).source, 'waiting');

  const select = (baseUrl, relayUrl, extraHeaders = {}) => fetch(`${baseUrl}/api/cstv`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ url: relayUrl }),
  });
  const manage = { 'X-WebRadar-Local': '1' };
  assert.equal((await select(base, url)).status, 403);
  assert.equal((await select(base, 'file:///game/csgo', manage)).status, 400);
  assert.equal((await select(`http://127.0.0.1:${viewerPort}`, url, manage)).status, 403);

  const received = new Promise(resolve => ws.on('message', bytes => {
    const state = JSON.parse(bytes);
    if (state.broadcast === 'live') resolve(state);
  }));
  assert.equal((await select(base, url, manage)).status, 202);
  const state = await waitForState(base, state => state.broadcast === 'live');
  assert.equal(state.source, 'cstv');
  assert.equal(state.map, 'de_nuke');
  assert.equal(state.tick, 81);
  assert.equal((await received).tick, 81);
  assert.deepEqual(state.score, { ct: 6, t: 4 });
  assert.deepEqual(state.players.map(({ team, x, y, z, hp }) => [team, x, y, z, hp]), [
    ['CT', -1500, 500, -450, 87],
    ['T', -1100, 100, -420, 54],
  ]);
  assert.equal(state.roster.length, 3);
  assert.equal(state.roster.find(row => row.name === 'Polegli').x, null);
  assert.equal(JSON.stringify(state).includes(url), false);
  assert.deepEqual((await received).players, state.players);
  assert.deepEqual(requests.slice(0, 4), ['/match/sync', '/match/0/start', '/match/1/full', '/match/1/delta']);

  await fetch(`${base}/gsi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: { name: 'de_ancient' }, player: { name: 'GSI gracz' } }),
  });
  assert.equal((await fetch(`${base}/api/state`).then(response => response.json())).source, 'cstv');
  assert.equal((await fetch(`${base}/api/cstv`, { method: 'DELETE', headers: manage })).status, 204);
  const gsi = await waitForState(base, state => state.source === 'gsi');
  assert.equal(gsi.map, 'de_ancient');
  assert.deepEqual(gsi.players, []);
});
