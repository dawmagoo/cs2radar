'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMapStore } = require('../map-store');
const { createRadarServer } = require('../server');
const { importDirectory } = require('../scripts/import-maps');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FkAAAAASUVORK5CYII=', 'base64');
const bounds = { minx: -3000, maxx: 3000, miny: -2000, maxy: 4000 };

async function temporaryDirectory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webradar-maps-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a LAN link reads the host map and calibration and cannot change them', async t => {
  const directory = await temporaryDirectory(t);
  const store = createMapStore(directory);
  const radar = createRadarServer({
    maps: store, gsiToken: 'game-fixture', lanAddresses: () => [{ ip: '127.0.0.1', name: 'Fixture' }],
  });
  t.after(() => radar.close());
  const port = await radar.listen(0);
  const host = `http://127.0.0.1:${port}`;
  const route = '/api/maps/de_nuke/lower';
  const manage = { 'x-webradar-local': '1' };
  const json = { ...manage, 'content-type': 'application/json' };

  assert.equal((await fetch(host + route + '/image', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png })).status, 403);
  assert.equal((await fetch(host + route + '/image', {
    method: 'PUT', headers: { ...manage, 'content-type': 'image/png' }, body: 'invalid picture',
  })).status, 415);
  assert.equal((await fetch(host + route + '/image', {
    method: 'PUT', headers: { ...manage, 'content-type': 'image/png' }, body: png,
  })).status, 204);
  assert.equal((await fetch(host + route + '/bounds', { method: 'PUT', headers: json, body: JSON.stringify(bounds) })).status, 204);
  assert.equal((await fetch(host + '/api/maps/de_nuke/basement')).status, 404);
  assert.deepEqual((await createMapStore(directory).info('de_nuke.lower')).bounds, bounds);

  const start = await fetch(host + '/api/share', { method: 'PUT', headers: json, body: '{"ip":"127.0.0.1"}' });
  assert.equal(start.status, 200);
  const share = new URL((await start.json()).link);
  const access = { 'x-view-token': new URLSearchParams(share.hash.slice(1)).get('token') };
  assert.equal((await fetch(share.origin + route)).status, 401);
  const profile = await fetch(share.origin + route, { headers: access });
  assert.deepEqual((await profile.json()).bounds, bounds);
  const image = await fetch(share.origin + route + '/image', { headers: access });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(share.origin + route + '/image', { method: 'DELETE', headers: { ...manage, ...access } })).status, 403);
  assert.equal((await fetch(share.origin + '/api/share', { headers: { ...manage, ...access } })).status, 403);

  assert.equal((await fetch(host + route + '/image', { method: 'DELETE', headers: manage })).status, 204);
  assert.equal((await fetch(share.origin + route + '/image', { headers: access })).status, 404);
  await fetch(host + '/api/share', { method: 'DELETE', headers: manage });
  await assert.rejects(fetch(share.origin + '/health'));
});

test('imports exported upper and lower textures with Valve overview calibration', async t => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, 'export');
  const graphics = path.join(root, 'panorama', 'images', 'overheadmaps');
  const overviews = path.join(root, 'resource', 'overviews');
  await fs.mkdir(graphics, { recursive: true });
  await fs.mkdir(overviews, { recursive: true });
  await fs.writeFile(path.join(graphics, 'de_nuke_radar_psd.png'), png);
  await fs.writeFile(path.join(graphics, 'de_nuke_lower_radar_psd.png'), png);
  await fs.writeFile(path.join(graphics, 'de_train_radar_tga.png'), 'invalid');
  await fs.writeFile(path.join(overviews, 'de_nuke.txt'), '"de_nuke" { "pos_x" "-3453" "pos_y" "2887" "scale" "7" }');

  const store = createMapStore(path.join(directory, 'profile'));
  const result = await importDirectory(root, { store });
  assert.deepEqual(result.imported.sort(), ['de_nuke.lower', 'de_nuke.upper']);
  assert.deepEqual(result.invalid, ['de_train_radar_tga.png']);
  const expected = { minx: -3453, maxx: 3715, miny: -4281, maxy: 2887 };
  assert.deepEqual((await store.info('de_nuke.upper')).bounds, expected);
  assert.deepEqual((await store.info('de_nuke.lower')).bounds, expected);

  await store.writeBounds('de_nuke.lower', bounds);
  const second = await importDirectory(root, { store });
  assert.equal(second.kept.length, 2);
  assert.deepEqual((await store.info('de_nuke.lower')).bounds, bounds);
});
