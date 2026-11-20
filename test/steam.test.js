'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findConfigDirectory, resolveConfigDirectory } = require('../steam');

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
