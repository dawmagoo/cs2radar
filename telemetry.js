'use strict';

const { createHash } = require('node:crypto');

function safeText(value, limit = 48) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, limit) : '';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function vector(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const parts = value.split(',').map(component => component.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part))) {
    return null;
  }
  const values = parts.map(Number);
  return values.every(number => Number.isFinite(number) && Math.abs(number) < 1_000_000) ? values : null;
}

function position(value) {
  const parts = vector(value);
  return { x: parts?.[0] ?? null, y: parts?.[1] ?? null, z: parts?.[2] ?? null };
}

function stat(value, max) {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : null;
}

function seconds(value) {
  if (typeof value === 'string' && /^\d{1,3}(?:\.\d+)?$/.test(value)) value = Number(value);
  return Number.isFinite(value) && value >= 0 && value <= 600 ? value : null;
}

function shortId(raw, fallback) {
  const key = safeText(raw, 64);
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : fallback;
}

function readPlayer(player, key) {
  if (!isRecord(player) || !Object.keys(player).length) return null;
  const forward = vector(player.forward);
  const items = Object.values(player.weapons || {}).filter(isRecord).slice(0, 24);
  const active = items.find(weapon => weapon.state === 'active');
  const activeName = safeText(active?.name);
  const utility = items.filter(item => item.type === 'Grenade' || /(?:grenade|flashbang|molotov|decoy)$/.test(item.name || ''))
    .map(item => ({ name: safeText(item.name), count: stat(item.ammo_reserve, 8) ?? 1 }))
    .filter(item => item.name && item.count);
  return {
    id: shortId(key ?? player.steamid, 'local'),
    name: safeText(player.name) || 'Gracz',
    team: ['CT', 'T'].includes(player.team) ? player.team : '',
    observerSlot: stat(player.observer_slot, 99),
    ...position(player.position),
    hp: stat(player.state?.health, 100),
    armor: stat(player.state?.armor, 100),
    money: stat(player.state?.money, 100_000),
    equipment: stat(player.state?.equip_value, 100_000),
    helmet: typeof player.state?.helmet === 'boolean' ? player.state.helmet : null,
    defuse: typeof player.state?.defusekit === 'boolean' ? player.state.defusekit : null,
    kills: stat(player.match_stats?.kills, 999),
    deaths: stat(player.match_stats?.deaths, 999),
    angle: forward && (forward[0] || forward[1]) ? Math.atan2(forward[1], forward[0]) * 180 / Math.PI : null,
    weapons: activeName ? [activeName] : [],
    primary: safeText(items.find(weapon => /^(Rifle|SniperRifle|Submachine Gun|SMG|Machine Gun|Shotgun)$/i.test(weapon.type))?.name),
    ammo: stat(active?.ammo_clip, 999),
    utility,
  };
}

function readGrenades(value) {
  if (!isRecord(value)) return [];
  return Object.entries(value).slice(0, 64).flatMap(([key, grenade], index) => {
    if (!isRecord(grenade)) return [];
    const coordinates = position(grenade.position);
    const type = safeText(grenade.type, 20);
    return coordinates.x !== null && type ? [{
      id: shortId(key, `grenade-${index}`),
      type,
      ...coordinates,
      effectTime: seconds(grenade.effecttime),
    }] : [];
  });
}

function readBomb(value) {
  if (!isRecord(value)) return null;
  const state = safeText(value.state, 20);
  if (!state) return null;
  return { state, ...position(value.position), remaining: seconds(value.countdown) };
}

function readState(body, updated = 0) {
  const focused = readPlayer(body.player);
  const others = isRecord(body.allplayers)
    ? Object.entries(body.allplayers).slice(0, 64).map(([id, player]) => readPlayer(player, id)).filter(Boolean)
    : [];
  const roster = others.length ? others : focused ? [focused] : [];
  const observed = focused ? roster.find(player => player.id === focused.id)
    ?? roster.find(player => player.observerSlot !== null && player.observerSlot === focused.observerSlot)
    : null;
  return {
    map: safeText(body.map?.name, 80) || 'unknown',
    mode: safeText(body.map?.mode, 24),
    phase: safeText(body.phase_countdowns?.phase || body.round?.phase || body.map?.phase, 20),
    remaining: seconds(body.phase_countdowns?.phase_ends_in),
    round: stat(body.map?.round, 999),
    score: {
      ct: stat(body.map?.team_ct?.score, 999),
      t: stat(body.map?.team_t?.score, 999),
    },
    player: observed ?? focused ?? roster[0] ?? null,
    roster,
    players: roster.filter(player => player.x !== null),
    grenades: readGrenades(body.grenades ?? body.allgrenades),
    bomb: readBomb(body.bomb),
    observer: others.length > 0,
    updated,
    source: updated ? 'gsi' : 'waiting',
  };
}

module.exports = { isRecord, readState };
