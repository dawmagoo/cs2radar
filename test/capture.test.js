'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const WebSocket = require('ws');
const { createRadarServer } = require('../server');

const frame = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

test('capture is relayed only to an authenticated LAN viewer after sharing is started', async t => {
  const radar = createRadarServer({ lanAddresses: () => [{ ip: '127.0.0.1', name: 'Test' }] });
  t.after(() => radar.close());
  const port = await radar.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const local = { 'x-webradar-local': '1' };
  const image = { ...local, 'content-type': 'image/jpeg' };
  const publish = (headers = image, bytes = frame, endpoint = base) => fetch(`${endpoint}/api/capture/frame`, {
    method: 'PUT', headers, body: bytes,
  });

  assert.equal((await publish()).status, 409);
  assert.equal(radar.feed.latestCapture(), null);
  const response = await fetch(`${base}/api/share`, {
    method: 'PUT', headers: { ...local, 'content-type': 'application/json' }, body: '{"ip":"127.0.0.1"}',
  });
  const link = new URL((await response.json()).link);
  const token = new URLSearchParams(link.hash.slice(1)).get('token');
  const url = `ws://${link.host}/ws`;
  await assert.rejects(once(new WebSocket(url), 'open'), /403/);
  const viewer = new WebSocket(`${url}?token=${token}`);
  const host = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([once(viewer, 'message'), once(host, 'message')]);
  let hostFrames = 0;
  host.on('message', (data, binary) => { if (binary) hostFrames += 1; });

  assert.equal((await publish({ 'content-type': 'image/jpeg' })).status, 403);
  assert.equal((await publish({ ...image, 'x-view-token': token }, frame, link.origin)).status, 403);
  assert.equal((await publish(image, Buffer.alloc(32))).status, 415);
  const received = once(viewer, 'message');
  assert.equal((await publish()).status, 204);
  const [data, binary] = await received;
  assert.equal(binary, true);
  assert.deepEqual(data, frame);
  assert.equal(hostFrames, 0);

  const stopped = once(viewer, 'message');
  assert.equal((await fetch(`${base}/api/capture/frame`, { method: 'DELETE', headers: local })).status, 204);
  const [event] = await stopped;
  assert.deepEqual(JSON.parse(event), { type: 'capture-ended' });
  assert.equal(radar.feed.latestCapture(), null);
});
