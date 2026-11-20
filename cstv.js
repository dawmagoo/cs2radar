'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { readState } = require('./telemetry');

const frameInterval = 125;
const bufferFrames = 40;
const maxFragmentBytes = 8 * 1024 * 1024;
const teamNames = { 2: 'T', 3: 'CT' };

function relayAddress(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  } catch {
    return null;
  }
}

function relayFetcher(relay) {
  async function fetchPart(part, limit, signal) {
    const url = new URL(relay);
    url.pathname += part.replace(/^\/+/, '');
    if (!url.pathname.startsWith(relay.pathname)) throw new Error('Nieprawidłowa ścieżka transmisji.');
    const timeout = AbortSignal.timeout(8000);
    const response = await fetch(url, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status };
    }

    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('Zbyt duży fragment transmisji.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > limit) throw new Error('Zbyt duży fragment transmisji.');
      chunks.push(chunk);
    }
    return { status: response.status, data: Buffer.concat(chunks, size) };
  }

  return {
    async json(part, signal) {
      const result = await fetchPart(part, 16 * 1024, signal);
      if (!result.data) throw new Error(`HTTP ${result.status}`);
      return JSON.parse(result.data.toString('utf8'));
    },
    async bytes(part, signal) {
      const result = await fetchPart(part, maxFragmentBytes, signal);
      if (result.data) return { ok: true, data: result.data };
      if (result.status === 404 || result.status === 405) return { ok: false, status: result.status };
      throw new Error(`HTTP ${result.status}`);
    },
  };
}

function matchMap(value) {
  const map = typeof value === 'string' ? value.toLowerCase().split('/').at(-1) : '';
  return /^[a-z0-9_-]{1,80}$/.test(map) && map !== 'unknown' ? map : '';
}

function broadcastState(parser, map) {
  const allplayers = Object.create(null);
  for (const player of parser.playerControllers) {
    const team = teamNames[player.teamNumber];
    if (!team || player.isHLTV) continue;
    const pawn = player.pawn;
    if (!player.isConnected && !pawn) continue;
    const id = player.steamId && player.steamId !== '0' ? player.steamId
      : `slot-${player.userInfo?.userid ?? player.entityId}`;
    const position = player.isAlive ? player.position : null;
    const yaw = player.isAlive ? player.eyeAngles.yaw * Math.PI / 180 : null;
    const inventory = player.inventory;
    const weapons = inventory?.items.map(item => ({
      name: item.name,
      state: item.itemId === inventory.activeItem?.itemId ? 'active' : 'holstered',
      ammo_reserve: item.quantity,
    }));
    allplayers[id] = {
      name: player.name,
      team,
      position: position ? `${position.x},${position.y},${position.z}` : undefined,
      forward: Number.isFinite(yaw) ? `${Math.cos(yaw)},${Math.sin(yaw)},0` : undefined,
      state: {
        health: pawn ? player.health : undefined,
        armor: pawn ? player.armor : undefined,
        money: player.money,
        helmet: pawn ? player.hasHelmet : undefined,
        defusekit: pawn ? player.hasDefuser : undefined,
      },
      match_stats: { kills: player.kills, deaths: player.deaths },
      weapons,
    };
  }
  const rules = parser.gameRules;
  let phase;
  if (rules) {
    if (rules.phase === 'postgame') phase = 'gameover';
    else if (rules.phase === 'halftime') phase = 'halftime';
    else if (rules.isWarmup) phase = 'warmup';
    else if (rules.isGamePaused || rules.isTerroristTimeOutActive || rules.isCTTimeOutActive) phase = 'paused';
    else phase = rules.isFreezePeriod ? 'freezetime' : 'live';
  }
  const teams = parser.teams;
  return readState({
    allplayers,
    round: { phase },
    map: {
      name: map,
      round: rules?.roundsPlayed,
      team_ct: { score: teams.find(team => team.teamNumber === 3)?.score },
      team_t: { score: teams.find(team => team.teamNumber === 2)?.score },
    },
  });
}

async function readBroadcast(relay, signal, publish) {
  const { DemoReader, EntityMode } = await import('cs2parser');
  if (signal.aborted) return 'cancelled';

  const parser = new DemoReader();
  const frames = [];
  let map = '';
  let step = 8;
  let lastTick = -Infinity;
  parser.on('broadcastsync', sync => {
    step = Math.min(128, Math.max(1, Math.round(sync.tps * frameInterval / 1000)));
    map = matchMap(sync.map);
  });
  parser.on('serverinfo', info => {
    const name = matchMap(info.map_name);
    if (name && name !== map) {
      frames.length = 0;
      lastTick = -Infinity;
      map = name;
    }
  });
  parser.on('tickend', tick => {
    if (!map || tick < 0 || tick - lastTick < step) return;
    lastTick = tick;
    if (frames.length >= bufferFrames) frames.shift();
    frames.push(broadcastState(parser, map));
  });
  const playFrame = () => {
    const frame = frames.shift();
    if (frame) publish({ ...frame, source: 'cstv', broadcast: 'live', updated: Date.now() });
  };
  const timer = setInterval(playFrame, frameInterval).unref();
  try {
    const result = await parser.parseHttpBroadcast(relay.href, {
      entities: EntityMode.ALL, fetcher: relayFetcher(relay), signal,
    });
    while (result.status === 'complete' && frames.length && !signal.aborted) {
      await sleep(frameInterval, undefined, { signal });
    }
    return result.status;
  } finally {
    clearInterval(timer);
  }
}

function createCstvSource(publish, restore) {
  let selected;
  return {
    active: () => Boolean(selected),
    start(value) {
      const address = relayAddress(value);
      if (!address) return false;
      selected?.abort();
      const session = new AbortController();
      selected = session;
      const update = state => { if (selected === session) publish(state); };
      const status = broadcast => update({ ...readState({}), source: 'cstv', broadcast });
      status('connecting');
      void readBroadcast(address, session.signal, update).then(
        outcome => status(outcome === 'complete' ? 'ended' : 'offline'),
        () => status('error'),
      );
      return true;
    },
    stop() {
      const session = selected;
      selected = undefined;
      session?.abort();
      if (session) restore();
    },
  };
}

module.exports = { createCstvSource };
