'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { configName, findConfigDirectory, installGsiConfig, renderGsiConfig, resolveConfigDirectory } = require('../steam');

async function makeGame(root) {
  const directory = path.join(root, 'game', 'csgo', 'cfg');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, '..', 'gameinfo.gi'), 'GameInfo {}');
  return fs.realpath(directory);
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webradar-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

test('detects a Steam library and manifest with a custom CS2 installation folder', async t => {
  const staging = await temporaryDirectory(t);
  const steam = path.join(staging, 'Steam');
  const library = path.join(staging, 'Biblioteka Gier');
  const game = path.join(library, 'steamapps', 'common', 'Counter Strike 2');
  const configDir = await makeGame(game);
  await makeGame(path.join(steam, 'steamapps', 'common', 'Counter-Strike Global Offensive'));
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "1" { "path" ${JSON.stringify(library)} "apps" { "730" "1" } } }`);
  await fs.writeFile(path.join(library, 'steamapps', 'appmanifest_730.acf'),
    '"AppState" { "appid" "730" "installdir" "Counter Strike 2" }');

  assert.equal(await findConfigDirectory(null, [steam]), configDir);
  for (const location of [game, path.join(game, 'game'), path.dirname(configDir), configDir]) {
    assert.equal(await resolveConfigDirectory(location), configDir);
  }
  assert.equal(await resolveConfigDirectory(library), null);
});

test('updates the old default and backs up edited settings only on explicit replacement', async t => {
  const cfg = await makeGame(await temporaryDirectory(t));
  const target = path.join(cfg, configName);
  const previous = (port, token) => renderGsiConfig(port, token).split('    "player_match_stats"')[0] + '  }\n}\n';
  const oldDefault = previous(3000)
    .replace('"heartbeat" "8.0"', '"heartbeat" "30.0"')
    .replace('    "round" "1"\n', '')
    .replaceAll('\n', '\r\n');
  await fs.writeFile(target, oldDefault);
  const first = await installGsiConfig(cfg, 3001, 'ab12');
  assert.equal(first.state, 'restart');
  assert.equal(await fs.readFile(first.backup, 'utf8'), oldDefault);
  assert.equal(await fs.readFile(target, 'utf8'), renderGsiConfig(3001, 'ab12'));
  assert.equal((await installGsiConfig(cfg, 3001, 'ab12')).state, 'ready');

  await fs.writeFile(target, previous(3001, 'ab12'));
  const updatedPort = await installGsiConfig(cfg, 3002, 'ab12');
  assert.equal(updatedPort.state, 'restart');
  assert.equal(await fs.readFile(updatedPort.backup, 'utf8'), previous(3001, 'ab12'));
  const custom = '"User config" { "uri" "http://127.0.0.1:9999/gsi" }\n';
  await fs.writeFile(target, custom);
  assert.equal((await installGsiConfig(cfg, 3002, 'ab12')).state, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), custom);
  const replaced = await installGsiConfig(cfg, 3002, 'ab12', { replace: true });
  assert.equal(replaced.state, 'restart');
  assert.equal(await fs.readFile(replaced.backup, 'utf8'), custom);
});

test('switches from the Windows app to the web server without discarding its managed token', async t => {
  const cfg = await makeGame(await temporaryDirectory(t));
  const target = path.join(cfg, configName);
  const original = renderGsiConfig(3000, 'desktop-token');
  await fs.writeFile(target, original);
  const web = await installGsiConfig(cfg, 3001, '', { preserveToken: true });
  assert.equal(web.state, 'restart');
  assert.equal(await fs.readFile(web.backup, 'utf8'), original);
  assert.equal(await fs.readFile(target, 'utf8'), renderGsiConfig(3001, 'desktop-token'));

  const desktop = await installGsiConfig(cfg, 3000, 'current-desktop-token');
  assert.equal(desktop.state, 'restart');
  assert.equal(await fs.readFile(target, 'utf8'), renderGsiConfig(3000, 'current-desktop-token'));
});
