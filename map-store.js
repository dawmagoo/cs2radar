'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');

const boundsFields = ['minx', 'maxx', 'miny', 'maxy'];
const maxImageBytes = 15 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function dataDirectory() {
  if (process.env.RADAR_DATA_DIR) return path.resolve(process.env.RADAR_DATA_DIR);
  const base = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA : process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(base, 'cs2-webradar', 'maps');
}

function mapKey(id, floor) {
  return /^[a-z0-9_-]{1,80}$/.test(id) && ['upper', 'lower'].includes(floor) ? `${id}.${floor}` : null;
}

function imageType(buffer) {
  if (buffer.length < 16) return null;
  if (buffer.subarray(0, 8).equals(pngSignature) && buffer.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function cleanBounds(bounds) {
  if (!bounds || !boundsFields.every(field => Number.isFinite(bounds[field]) && Math.abs(bounds[field]) <= 1_000_000)
    || bounds.maxx <= bounds.minx || bounds.maxy <= bounds.miny) return null;
  return Object.fromEntries(boundsFields.map(field => [field, bounds[field]]));
}

async function optional(read) {
  try {
    return await read();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function createMapStore(root = dataDirectory()) {
  function file(key, extension) {
    if (!/^[a-z0-9_-]{1,80}\.(?:upper|lower)$/.test(key)) throw new Error('Nieprawidłowa mapa lub poziom.');
    return path.join(root, `${key}.${extension}`);
  }

  async function write(target, value) {
    await fs.mkdir(root, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, value, { flag: 'wx' });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function info(key) {
    const [image, raw] = await Promise.all([
      optional(() => fs.stat(file(key, 'image'), { bigint: true })),
      optional(() => fs.readFile(file(key, 'bounds'), 'utf8')),
    ]);
    let bounds = null;
    try {
      if (raw) bounds = cleanBounds(JSON.parse(raw));
    } catch {
      // Fall back to the map preset when an on-disk calibration is damaged.
    }
    return { image: image?.isFile() ? `${image.mtimeNs}-${image.size}` : null, bounds };
  }

  async function readImage(key) {
    const bytes = await optional(() => fs.readFile(file(key, 'image')));
    const type = bytes && imageType(bytes);
    return type ? { bytes, type, etag: createHash('sha256').update(bytes).digest('base64url') } : null;
  }

  async function writeImage(key, bytes, type) {
    if (!Buffer.isBuffer(bytes) || bytes.length > maxImageBytes || !type || imageType(bytes) !== type) return false;
    await write(file(key, 'image'), bytes);
    return true;
  }

  async function writeBounds(key, bounds) {
    const clean = cleanBounds(bounds);
    if (!clean) return false;
    await write(file(key, 'bounds'), JSON.stringify(clean));
    return true;
  }

  return { info, readImage, writeImage, writeBounds,
    removeImage: key => fs.rm(file(key, 'image'), { force: true }),
    removeBounds: key => fs.rm(file(key, 'bounds'), { force: true }),
  };
}

module.exports = { createMapStore, imageType, mapKey, maxImageBytes };
