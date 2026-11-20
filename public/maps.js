const maps = new Map([
  ['de_mirage', { name: 'Mirage', x: -3230, y: 1713, scale: 5 }],
  ['de_dust2', { name: 'Dust II', x: -2476, y: 3239, scale: 4.4 }],
  ['de_inferno', { name: 'Inferno', x: -2087, y: 3870, scale: 4.9 }],
  ['de_nuke', { name: 'Nuke', x: -3453, y: 2887, scale: 7, lowerBelow: -495 }],
  ['de_ancient', { name: 'Ancient', x: -2953, y: 2164, scale: 5 }],
  ['de_anubis', { name: 'Anubis', x: -2796, y: 3328, scale: 5.22 }],
  ['de_vertigo', { name: 'Vertigo', x: -3168, y: 1762, scale: 4, lowerBelow: 11700 }],
  ['de_overpass', { name: 'Overpass', x: -4831, y: 1781, scale: 5.2 }],
  ['de_train', { name: 'Train', x: -2308, y: 2078, scale: 4.082077, lowerBelow: -50 }],
  ['de_cache', { name: 'Cache', x: -2000, y: 3250, scale: 5.5 }],
]);

const boundsFields = ['minx', 'maxx', 'miny', 'maxy'];
let database;

function mapId(value) {
  const id = String(value || '').toLowerCase().split('/').at(-1);
  return id !== 'unknown' && /^[a-z0-9_-]{1,80}$/.test(id) ? id : '';
}

function defaultBounds(id) {
  const map = maps.get(id);
  if (!map) return { minx: -3000, maxx: 3000, miny: -3000, maxy: 3000 };
  const span = map.scale * 1024;
  return { minx: map.x, maxx: map.x + span, miny: map.y - span, maxy: map.y };
}

function validBounds(bounds) {
  return bounds && boundsFields.every(field => Number.isFinite(bounds[field]) && Math.abs(bounds[field]) <= 1000000)
    && bounds.maxx > bounds.minx && bounds.maxy > bounds.miny;
}

function readCalibration(key, id) {
  try {
    const value = JSON.parse(localStorage.getItem(`cal:${key}`));
    if (validBounds(value)) return value;
  } catch {
    // A damaged or unavailable calibration falls back to the map preset.
  }
  return defaultBounds(id);
}

function writeCalibration(key, value) {
  if (value) localStorage.setItem(`cal:${key}`, JSON.stringify(value));
  else localStorage.removeItem(`cal:${key}`);
}

function openImageDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('cs2-webradar', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('map-images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function mapImage(key, file) {
  const db = await openImageDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('map-images', file === undefined ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('map-images');
    const request = file === undefined ? store.get(key) : (file === null ? store.delete(key) : store.put(file, key));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function decodeImage(source) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const release = typeof source === 'string' ? () => {} : () => URL.revokeObjectURL(url);
  const element = new Image();
  element.src = url;
  try {
    await element.decode();
    if (element.naturalWidth > 8192 || element.naturalHeight > 8192) throw new Error('Obraz przekracza 8192 px.');
    return { element, release };
  } catch (error) {
    release();
    throw error;
  }
}

export { boundsFields, decodeImage, defaultBounds, mapId, mapImage, maps, readCalibration, validBounds, writeCalibration };
