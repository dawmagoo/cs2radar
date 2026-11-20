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

test('starting the web app leaves the game directory untouched', async t => {
  const fixture = await fs.mkdtemp(path.join(tmpdir(), 'webradar-start-'));
  t.after(() => fs.rm(fixture, { force: true, recursive: true }));
  const game = path.join(fixture, 'Steam Library', 'Counter-Strike Global Offensive');
  const cfg = path.join(game, 'game', 'csgo', 'cfg');
  await fs.mkdir(cfg, { recursive: true });
  await fs.writeFile(path.join(cfg, '..', 'gameinfo.gi'), 'GameInfo {}');
  const legacy = path.join(cfg, 'gamestate_integration_webradar.cfg');
  await fs.writeFile(legacy, 'existing fixture');

  const slot = createServer().listen(0, '127.0.0.1');
  await once(slot, 'listening');
  const port = slot.address().port;
  await new Promise(resolve => slot.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CS2_PATH: game, GSI_TOKEN: '', VIEW_TOKEN: '' },
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

  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) assert.fail(output);
    const response = await fetch(`${base}/health`).catch(() => null);
    if (response?.ok) {
      health = await response.json();
      break;
    }
    await setTimeout(50);
  }
  assert.equal(health?.captureAvailable, true, output);
  assert.equal((await fetch(`${base}/api/gsi-config`)).status, 404);
  assert.equal((await fetch(`${base}/api/gsi-setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webradar-local': '1' },
    body: JSON.stringify({ action: 'choose', directory: game }),
  })).status, 404);
  assert.deepEqual(await fs.readdir(cfg), [path.basename(legacy)]);
  assert.equal(await fs.readFile(legacy, 'utf8'), 'existing fixture');
});
