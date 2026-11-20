'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout } = require('node:timers/promises');
const { configName } = require('../steam');

test('the npm start entry point installs GSI and receives the first game update', async t => {
  const fixture = await fs.mkdtemp(path.join(tmpdir(), 'webradar-start-'));
  t.after(() => fs.rm(fixture, { force: true, recursive: true }));
  const game = path.join(fixture, 'Steam Library', 'Counter-Strike Global Offensive');
  const cfg = path.join(game, 'game', 'csgo', 'cfg');
  await fs.mkdir(cfg, { recursive: true });
  await fs.writeFile(path.join(cfg, '..', 'gameinfo.gi'), 'GameInfo {}');

  const slot = createServer().listen(0, '127.0.0.1');
  await once(slot, 'listening');
  const port = slot.address().port;
  await new Promise(resolve => slot.close(resolve));
  const cwd = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CS2_PATH: game, GSI_TOKEN: 'test-configuration', VIEW_TOKEN: '' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });

  let written = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) assert.fail(output);
    written = await fs.readFile(path.join(cfg, configName), 'utf8').catch(() => '');
    if (written.includes('/gsi')) break;
    await setTimeout(50);
  }
  assert.ok(written.includes(`http://127.0.0.1:${port}/gsi`), output);
  assert.ok(written.includes('"token" "test-configuration"'), output);
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-webradar-local': '1' };
  const initial = await fetch(`${base}/api/gsi-setup`, { headers }).then(response => response.json());
  assert.ok(['checking', 'restart'].includes(initial.state));
  assert.equal((await fetch(`${base}/api/gsi-setup`)).status, 403);

  const update = await fetch(`${base}/gsi`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auth: { token: 'test-configuration' }, provider: { appid: 730 }, map: { name: 'de_nuke' },
      player: { name: 'GSI fixture', position: '25, 50, -700' },
    }),
  });
  assert.equal(update.status, 200);
  const downloaded = await fetch(`${base}/api/gsi-config`).then(response => response.text());
  assert.equal(downloaded, written);
  const diagnostics = await fetch(`${base}/health`).then(response => response.json());
  assert.equal(diagnostics.receiver.map, 'de_nuke');
  assert.equal(diagnostics.receiver.positions, 1);
});
