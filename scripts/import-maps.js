'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { parseArgs, promisify } = require('node:util');
const { createMapStore, imageType, mapKey, maxImageBytes } = require('../map-store');
const { findConfigDirectory, resolveConfigDirectory } = require('../steam');

const exec = promisify(execFile);
const overviewFolder = path.join('resource', 'overviews');
const imageFolder = path.join('panorama', 'images', 'overheadmaps');
const mapsWithLevels = new Set(['de_nuke', 'de_vertigo', 'de_train']);

function imageIdentity(file) {
  const extension = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return null;
  const original = path.basename(file, path.extname(file)).toLowerCase();
  let name = original.replace(/_(?:psd|tga|png)$/, '');
  let floor = 'upper';
  if (name.endsWith('_lower') || name.endsWith('_upper')) {
    floor = name.endsWith('_lower') ? 'lower' : 'upper';
    name = name.slice(0, -6);
  }
  name = name.replace(/_radar$/, '');
  if (name.endsWith('_lower') || name.endsWith('_upper')) {
    floor = name.endsWith('_lower') ? 'lower' : 'upper';
    name = name.slice(0, -6);
  }
  if (!/^(?:de|cs|ar|dz|gd|aim|training)_[a-z0-9_-]+$/.test(name) || !mapKey(name, floor)) return null;
  return { name, floor };
}

function overviewBounds(content) {
  const [x, y, scale] = ['pos_x', 'pos_y', 'scale'].map(field =>
    Number(content.match(new RegExp(`"${field}"\\s+"(-?\\d+(?:\\.\\d+)?)"`, 'i'))?.[1]));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(scale > 0 && scale < 500)) return null;
  const span = scale * 1024;
  return { minx: x, maxx: x + span, miny: y - span, maxy: y };
}

async function regularFiles(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => path.join(directory, entry.name)).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

async function importDirectory(directory, { store = createMapStore(), replace = false } = {}) {
  const [flat, textures, overviews] = await Promise.all([
    regularFiles(directory),
    regularFiles(path.join(directory, imageFolder)),
    regularFiles(path.join(directory, overviewFolder)),
  ]);
  const boundsByName = new Map();
  for (const file of [...overviews, ...flat]) {
    if (path.extname(file).toLowerCase() !== '.txt' || (await fs.stat(file)).size > 128 * 1024) continue;
    const name = path.basename(file, path.extname(file)).toLowerCase();
    const bounds = overviewBounds(await fs.readFile(file, 'utf8'));
    if (bounds) boundsByName.set(name, bounds);
  }

  const seen = new Set();
  const result = { imported: [], kept: [], invalid: [] };
  for (const file of [...textures, ...flat]) {
    const identity = imageIdentity(file);
    if (!identity) continue;
    const { name, floor } = identity;
    const key = mapKey(name, floor);
    if (seen.has(key)) continue;
    const profile = await store.info(key);
    if (profile.image && !replace) {
      result.kept.push(key);
      seen.add(key);
      continue;
    }
    const bytes = (await fs.stat(file)).size <= maxImageBytes ? await fs.readFile(file) : null;
    if (!bytes || !await store.writeImage(key, bytes, imageType(bytes))) {
      result.invalid.push(path.basename(file));
      continue;
    }
    const calibration = boundsByName.get(name);
    if (calibration && (!profile.bounds || replace)) await store.writeBounds(key, calibration);
    if (calibration && mapsWithLevels.has(name)) {
      const otherKey = mapKey(name, floor === 'upper' ? 'lower' : 'upper');
      const other = await store.info(otherKey);
      if (!other.bounds) await store.writeBounds(otherKey, calibration);
    }
    seen.add(key);
    result.imported.push(key);
  }
  return result;
}

async function importSteamMaps({ viewer, cs2, replace }) {
  const cfg = cs2 ? await resolveConfigDirectory(path.resolve(cs2)) : await findConfigDirectory();
  if (!cfg) throw new Error('Wskaż folder gry przez --cs2.');
  const vpk = path.join(cfg, '..', 'pak01_dir.vpk');
  if (!(await fs.stat(vpk)).isFile()) throw new Error('Oczekiwano pliku pak01_dir.vpk.');
  const executable = path.resolve(viewer);
  if (!(await fs.stat(executable)).isFile()) throw new Error('Wskaż plik wykonywalny Source2Viewer-CLI.');
  const staging = await fs.mkdtemp(path.join(tmpdir(), 'cs2-radar-maps-'));
  try {
    await exec(executable, [
      '--input', vpk, '--output', staging, '--vpk_decompile',
      '--vpk_filepath', 'panorama/images/overheadmaps/,resource/overviews/',
      '--vpk_extensions', 'vtex_c,ctex_c,png,txt',
    ], { windowsHide: true, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
    return await importDirectory(staging, { replace });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, viewer: { type: 'string' }, cs2: { type: 'string' }, replace: { type: 'boolean' },
  } });
  if (Boolean(values.from) === Boolean(values.viewer)) {
    throw new Error('Użycie: npm run maps:import -- --from <folder eksportu> albo --viewer <ścieżka do Source2Viewer-CLI> [--cs2 <folder gry>] [--replace].');
  }
  const result = values.from
    ? await importDirectory(path.resolve(values.from), { replace: values.replace })
    : await importSteamMaps(values);
  if (!result.imported.length && !result.kept.length) throw new Error('Folder nie zawiera pasujących grafik radaru.');
  console.log(`Zaimportowano grafik: ${result.imported.length}. Zachowano istniejących: ${result.kept.length}.`);
  if (result.invalid.length) console.log(`Pominięte obrazy: ${result.invalid.join(', ')}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { importDirectory };
