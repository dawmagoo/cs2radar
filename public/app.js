import {
  boundsFields, decodeImage, defaultBounds, mapId, mapImage, maps, readCalibration, savedCalibration, validBounds, writeCalibration,
} from './maps.js';
import { createRadar, onMap, project } from './radar.js';
import { demoState } from './demo.js';
import { createLocalApi } from './local-api.js';

const $ = id => document.getElementById(id);
const dash = '—';
const setup = window.webRadarSetup;
const api = createLocalApi(() => $('auth').value.trim());
const sharingControls = setup ?? api;
const setupControls = setup ?? {
  detect: () => api.configureGsi('detect'),
  choose: () => api.configureGsi('choose', $('gameFolder').value),
  replace: () => api.configureGsi('replace'),
};
const gsiRejections = {
  auth: 'Gra używa innego tokenu GSI. Zapisz aktualny plik i uruchom CS2 ponownie.',
  host: 'Pakiet dotarł pod niewłaściwy adres. Zapisz aktualny plik, aby ustawić adres tego radaru.',
  format: 'Pakiet dotarł, ale serwer odrzucił jego format. Zapisz aktualny plik GSI i uruchom CS2 ponownie.',
  size: 'Pakiet GSI przekroczył limit rozmiaru. Zapisz aktualny plik WebRadar i uruchom CS2 ponownie.',
  game: 'Serwer odebrał pakiet innej gry. Sprawdź adres GSI dla CS2.',
};
const tokenKey = 'cs2-webradar:view-token';
const staleAfter = 40_000;
const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const phases = { live: 'w toku', freezetime: 'zakupy', over: 'koniec rundy', warmup: 'rozgrzewka', gameover: 'koniec meczu', bomb: 'podłożona bomba', defuse: 'rozbrajanie', paused: 'pauza', halftime: 'przerwa' };
const bombs = { carried: 'Bomba niesiona', dropped: 'Bomba na ziemi', planting: 'Podkładanie bomby', planted: 'Bomba podłożona', defusing: 'Rozbrajanie bomby', defused: 'Bomba rozbrojona', exploded: 'Bomba eksplodowała' };
const equipmentNames = { smokegrenade: 'Dym', flashbang: 'Flash', hegrenade: 'HE', molotov: 'Mołotow', incgrenade: 'Zapalający', decoy: 'Wabik' };
const viewControls = ['teamFilter', 'markerScale', 'names', 'utility', 'trails', 'follow'];
const moneyFormat = new Intl.NumberFormat('pl-PL');
const radar = createRadar($('radar'), zoom => { $('zoomLabel').value = `${Math.round(zoom * 100)}%`; }, focusPlayer);
let live = {};
let receivedAt = 0;
let serverAge = Infinity;
let socket;
let retry;
let retryDelay = 800;
let connection = 'connecting';
let viewTokenRequired = false;
let fallbackInfo;
let demoStarted = null;
let autoMap = true;
let selectedMap = 'de_mirage';
let levelChoice = 'auto';
let level = 'upper';
let activeKey;
let image;
let imageRequest = 0;
let usingCustomImage = false;
let focusId;
let rosterKey = '';
let rosterButtons = new Map();
let shareInfo;
let mapAccess = 'browser';
let hostMap;
let sharedSyncRunning = false;
let boundsDirty = false;
let grenadeTrails = new Map();
let trailMatch;
let trailStamp;
let setupState;
let receiver;
let receiverBusy = false;
let setupBusy = false;
let viewOnly = false;

function text(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}

function boundsFromForm() {
  return Object.fromEntries(boundsFields.map(id => [id, $(id).valueAsNumber]));
}

function currentBounds() {
  const tentative = boundsFromForm();
  return validBounds(tentative) ? tentative : hostMap?.bounds ?? readCalibration(activeKey, selectedMap);
}

function setBounds(bounds) {
  for (const id of boundsFields) $(id).value = Number(bounds[id].toFixed(4));
}

function nameForMap(id) {
  return maps.get(id)?.name ?? id;
}

function updateImage(next, custom, message) {
  if (image !== next) image?.release();
  image = next;
  usingCustomImage = custom;
  $('removeImage').hidden = !custom || mapAccess === 'viewer';
  text('imageMode', image ? 'Grafika mapy' : 'Siatka współrzędnych');
  text('imageStatus', message);
  render();
}

async function moveLegacyMap(key, meta) {
  let imported = false;
  const bounds = !meta.bounds && savedCalibration(key);
  if (bounds) {
    await api.saveBounds(key, bounds);
    writeCalibration(key, null);
    imported = true;
  }
  if (!meta.image) {
    const record = await mapImage(key).catch(() => null);
    if (record) {
      await api.saveImage(key, record);
      await mapImage(key, null).catch(() => {});
      imported = true;
    }
  }
  return imported ? api.mapInfo(key) : meta;
}

async function loadMapImage(knownProfile, { keepBounds = false } = {}) {
  const request = ++imageRequest;
  const key = activeKey;
  const id = selectedMap;
  const file = `${id}${maps.get(id)?.lowerBelow !== undefined ? `_${level}` : ''}.png`;
  if (mapAccess !== 'browser') {
    try {
      let profile = knownProfile ?? await api.mapInfo(key);
      if (request !== imageRequest) return;
      if (mapAccess === 'host') profile = await moveLegacyMap(key, profile).catch(() => profile);
      const blob = profile.image && await api.mapImage(key);
      const next = blob ? await decodeImage(blob) : null;
      if (request !== imageRequest) return next?.release();
      hostMap = profile;
      if (!keepBounds) setBounds(profile.bounds ?? defaultBounds(id));
      if (next) return updateImage(next, true, mapAccess === 'viewer' ? 'Grafika udostępniona przez hosta.' : 'Zapisana grafika mapy.');
    } catch {
      if (request !== imageRequest || mapAccess === 'viewer') return;
    }
  }
  if (mapAccess !== 'viewer') {
    try {
      const stored = await mapImage(key);
      if (stored) {
        const next = await decodeImage(stored);
        if (request !== imageRequest) return next.release();
        return updateImage(next, true, `Zapisana grafika: ${stored.name || 'obraz mapy'}`);
      }
    } catch {
      // Continue with the bundled map or coordinate grid.
    }
  }
  if (request !== imageRequest) return;
  try {
    const files = await fallbackInfo;
    if (files.includes(file)) {
      const next = await decodeImage(`/maps/${file}`);
      if (request !== imageRequest) return next.release();
      return updateImage(next, false, `Wczytano ${file}.`);
    }
  } catch {
    // The grid is available even if a bundled image cannot be read.
  }
  if (request === imageRequest) updateImage(null, false, mapAccess === 'viewer'
    ? 'Host korzysta z siatki współrzędnych.'
    : 'Dodaj PNG, JPG lub WebP do 15 MB. Instrukcja repozytorium opisuje import map z CS2.');
}

async function syncSharedMap() {
  if (mapAccess === 'browser' || connection !== 'open' || sharedSyncRunning) return;
  const key = activeKey;
  sharedSyncRunning = true;
  try {
    const profile = await api.mapInfo(key);
    if (key !== activeKey) return;
    if (profile.image !== hostMap?.image) await loadMapImage(profile, { keepBounds: boundsDirty });
    else if (JSON.stringify(profile.bounds) !== JSON.stringify(hostMap?.bounds)) {
      hostMap = profile;
      if (!boundsDirty) setBounds(profile.bounds ?? defaultBounds(selectedMap));
      render();
    }
  } catch {
    // The next refresh can restore the shared background after a lost connection.
  } finally {
    sharedSyncRunning = false;
  }
}

function refreshMap() {
  const liveMap = mapId(live.map);
  if (autoMap && demoStarted === null && liveMap && liveMap !== selectedMap) {
    selectedMap = liveMap;
    levelChoice = 'auto';
  }
  const lowerBelow = maps.get(selectedMap)?.lowerBelow;
  const z = demoStarted === null && liveMap === selectedMap ? selectedPlayer(live)?.z : null;
  const automaticLevel = Number.isFinite(z) && z < lowerBelow ? 'lower' : 'upper';
  level = lowerBelow === undefined ? 'upper' : (levelChoice === 'auto' ? automaticLevel : levelChoice);
  $('levelWrap').hidden = lowerBelow === undefined;
  $('levelSelect').value = levelChoice;

  const picker = $('mapSelect');
  if (![...picker.options].some(option => option.value === selectedMap)) picker.add(new Option(nameForMap(selectedMap), selectedMap));
  picker.value = selectedMap;
  $('autoMap').setAttribute('aria-pressed', String(autoMap));
  text('map', nameForMap(selectedMap));
  const mode = autoMap ? 'Mapa automatyczna' : 'Wybór ręczny';
  const floor = lowerBelow === undefined ? '' : (level === 'lower' ? ' · dolny poziom' : ' · górny poziom');
  text('mapMode', mode + floor);

  const key = `${selectedMap}:${level}`;
  if (key === activeKey) return;
  activeKey = key;
  boundsDirty = false;
  hostMap = null;
  setBounds(mapAccess === 'viewer' ? defaultBounds(selectedMap) : readCalibration(key, selectedMap));
  $('mapFile').value = '';
  text('calStatus', '');
  radar.reset();
  updateImage(null, false, 'Wczytuję mapę…');
  void loadMapImage();
}

function focusPlayer(id) {
  focusId = id;
  refreshMap();
  render();
}

function selectedPlayer(state) {
  return state.roster?.find(player => player.id === focusId) ?? state.player;
}

function showMoney(value) {
  return Number.isFinite(value) ? `${moneyFormat.format(value)} $` : dash;
}

function formatClock(value) {
  const seconds = Math.max(0, Math.ceil(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function prettyWeapon(value) {
  const short = value?.replace(/^weapon_/, '');
  return short?.replaceAll('_', ' ').toUpperCase() || dash;
}

function showRoster(active, player) {
  $('teamPanel').hidden = !active.observer;
  $('clearPlayer').hidden = !focusId;
  const groups = ['CT', 'T', ''].map(team => ({
    team,
    players: (active.observer ? active.roster || [] : []).filter(player => player.team === team)
      .sort((a, b) => ((a.observerSlot ?? 99) - (b.observerSlot ?? 99)) || a.name.localeCompare(b.name)),
  })).filter(group => group.players.length);
  const key = groups.map(group => group.team + group.players.map(player => player.id).join(',')).join('|');
  if (key !== rosterKey) {
    rosterKey = key;
    rosterButtons = new Map();
    $('roster').replaceChildren(...groups.map(({ team, players }) => {
      const list = document.createElement('section');
      list.className = 'team-list';
      const header = document.createElement('h3');
      const badge = document.createElement('span');
      badge.className = `team-label ${team.toLowerCase()}`;
      badge.textContent = team || 'Pozostali';
      header.append(badge);
      list.append(header);
      for (const member of players) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'roster-row';
        row.dataset.team = team;
        const name = document.createElement('span');
        name.className = 'roster-name';
        const hp = document.createElement('span');
        hp.className = 'roster-hp';
        const money = document.createElement('span');
        money.className = 'roster-money';
        const meter = document.createElement('meter');
        meter.min = 0;
        meter.max = 100;
        meter.optimum = 100;
        meter.setAttribute('aria-label', 'Zdrowie');
        row.append(name, hp, money, meter);
        row.addEventListener('click', () => focusPlayer(member.id === focusId ? undefined : member.id));
        list.append(row);
        rosterButtons.set(member.id, { row, name, hp, money, meter });
      }
      return list;
    }));
  }
  for (const { players } of groups) {
    for (const member of players) {
      const nodes = rosterButtons.get(member.id);
      nodes.name.textContent = member.name;
      nodes.row.title = `${member.name} · ${prettyWeapon(member.primary || member.weapons?.[0])}`;
      nodes.hp.textContent = member.hp ?? dash;
      nodes.money.textContent = showMoney(member.money);
      nodes.row.dataset.dead = String(member.hp === 0);
      nodes.row.setAttribute('aria-pressed', String(player?.id === member.id));
      nodes.meter.hidden = member.hp == null;
      nodes.meter.value = member.hp ?? 0;
    }
  }
}

function setStatus(state, label) {
  $('status').dataset.state = state;
  text('status', label);
}

function recordGrenadeTrails(snapshot) {
  const match = `${snapshot.map}:${snapshot.round}`;
  if (match !== trailMatch || snapshot.updated - trailStamp > 1500 || snapshot.updated < trailStamp) {
    grenadeTrails = new Map();
  }
  if (snapshot.updated === trailStamp && match === trailMatch) return;
  trailMatch = match;
  trailStamp = snapshot.updated;
  const present = new Set();
  for (const item of snapshot.grenades || []) {
    present.add(item.id);
    const points = (grenadeTrails.get(item.id) || []).filter(point => snapshot.updated - point.time <= 3000);
    const previous = points.at(-1);
    if (!previous || Math.hypot(previous.x - item.x, previous.y - item.y) >= 3) {
      points.push({ x: item.x, y: item.y, z: item.z, time: snapshot.updated });
    }
    grenadeTrails.set(item.id, points.slice(-32));
  }
  for (const id of grenadeTrails.keys()) {
    if (!present.has(id)) grenadeTrails.delete(id);
  }
}

function render() {
  const demo = demoStarted !== null;
  const bounds = currentBounds();
  const active = demo ? demoState(selectedMap, bounds, (performance.now() - demoStarted) / 1000) : live;
  const age = serverAge + performance.now() - receivedAt;
  const stale = age > staleAfter;
  const fresh = demo || (connection === 'open' && !stale);
  const player = selectedPlayer(active);
  const point = project(player, bounds);
  const correctMap = mapId(active.map) === selectedMap;
  const lowerBelow = maps.get(selectedMap)?.lowerBelow;
  const onLevel = item => demo || !Number.isFinite(item?.z) || lowerBelow === undefined
    || (item.z < lowerBelow ? 'lower' : 'upper') === level;
  const filter = $('teamFilter').value;
  const visiblePlayers = fresh && correctMap
    ? (active.players || []).filter(item => item.hp !== 0 && onLevel(item) && (filter === 'all' || filter === item.team))
    : [];
  const visibleUtility = [];
  const bomb = active.bomb;
  if ($('utility').checked && fresh && correctMap) {
    const trailsOn = $('trails').checked;
    for (const item of (active.grenades || []).filter(onLevel)) {
      const samples = demo ? item.trail : grenadeTrails.get(item.id);
      const trail = trailsOn && samples ? samples.filter(onLevel) : [];
      visibleUtility.push({ ...item, trail });
    }
    if (bomb && ['planted', 'planting', 'defusing', 'dropped'].includes(bomb.state) && onLevel(bomb)) {
      visibleUtility.push({ ...bomb, type: 'bomb' });
    }
  }
  const showMarker = visiblePlayers.some(item => item.id === player?.id && onMap(project(item, bounds)));
  const authNeeded = ['token', 'denied'].includes(connection);

  if (demo) setStatus('demo', 'Tryb demonstracyjny');
  else if (connection === 'token') setStatus('waiting', 'Podaj token podglądu');
  else if (connection === 'denied') setStatus('offline', 'Nieprawidłowy token podglądu');
  else if (connection !== 'open') setStatus('offline', connection === 'connecting' ? 'Łączenie z radarem…' : 'Ponawiam połączenie…');
  else if (!live.updated) setStatus('waiting', 'Oczekiwanie na CS2');
  else if (stale) setStatus('waiting', 'Brak nowych danych z CS2');
  else setStatus('live', 'Połączono z CS2');

  $('demoTag').hidden = !demo;
  $('sourceTag').hidden = demo || !live.updated;
  text('sourceTag', active.observer ? 'Obserwator · obie drużyny' : 'Telemetria gracza');
  if (!demo && fresh && !active.observer && visiblePlayers.length === 0 && !point) $('sourceTag').dataset.limited = 'true';
  else delete $('sourceTag').dataset.limited;
  $('center').disabled = !showMarker;
  const elapsed = Math.max(0, Math.floor(age / 1000));
  text('lastUpdate', demo ? 'Przykład' : live.updated ? (elapsed < 1 ? 'Teraz' : `${elapsed} s temu`) : dash);
  text('ctScore', String(active.score?.ct ?? dash));
  text('tScore', String(active.score?.t ?? dash));
  const phase = Object.hasOwn(phases, active.phase) ? ` · ${phases[active.phase]}` : '';
  text('round', `Runda ${active.round ?? dash}${phase}`);
  const gameClock = fresh && Number.isFinite(active.remaining)
    ? formatClock(active.remaining - (demo || active.phase === 'paused' ? 0 : age / 1000)) : '';
  $('roundClock').hidden = !gameClock;
  text('roundClock', gameClock);
  const bombLabel = fresh && bomb && Object.hasOwn(bombs, bomb.state) ? bombs[bomb.state] : '';
  $('bombStatus').hidden = !bombLabel;
  const bombClock = Number.isFinite(bomb?.remaining) ? ` · ${formatClock(bomb.remaining - (demo ? 0 : age / 1000))}` : '';
  text('bombStatus', bombLabel ? bombLabel + bombClock : '');
  text('playerName', player?.name || 'Brak danych gracza');
  const team = $('playerTeam');
  team.hidden = !player?.team;
  team.className = `team-label ${player?.team === 'CT' ? 'ct' : player?.team === 'T' ? 't' : ''}`;
  text('playerTeam', player?.team || '');
  const coordinates = point ? [`X ${Math.round(player.x)}`, `Y ${Math.round(player.y)}`] : null;
  if (coordinates && Number.isFinite(player.z)) coordinates.push(`Z ${Math.round(player.z)}`);
  text('playerPosition', coordinates?.join(' · ') ?? 'Brak pozycji');
  text('playerHealth', String(player?.hp ?? dash));
  text('playerArmor', String(player?.armor ?? dash));
  text('playerMoney', showMoney(player?.money));
  text('playerKd', (player?.kills != null || player?.deaths != null) ? `${player.kills ?? dash} / ${player.deaths ?? dash}` : dash);
  text('playerWeapon', prettyWeapon(player?.weapons?.[0] || player?.primary) + (Number.isFinite(player?.ammo) ? ` · ${player.ammo}` : ''));
  const loadout = (player?.utility || []).map(item => {
    const key = item.name.replace(/^weapon_/, '');
    return `${Object.hasOwn(equipmentNames, key) ? equipmentNames[key] : prettyWeapon(item.name)} ×${item.count}`;
  });
  if (player?.helmet) loadout.push('Hełm');
  if (player?.defuse) loadout.push('Zestaw do rozbrajania');
  $('utilityPanel').hidden = loadout.length === 0;
  text('playerUtility', loadout.join(' · '));
  showRoster(active, player);

  const waiting = !demo && !authNeeded && !live.updated && connection === 'open';
  $('gsiWaiting').hidden = !waiting;
  $('waitingSetup').hidden = viewOnly;
  if (waiting) text('gsiWaitingMessage', waitingMessage());
  let hint = '';
  if (!demo && authNeeded) hint = 'Wpisz token w sekcji Dostęp LAN.';
  else if (waiting) hint = '';
  else if (!demo && !live.updated) hint = 'Łączę się z lokalnym serwerem radaru.';
  else if (!demo && live.map === 'unknown') hint = 'Serwer odbiera dane. Wejdź do meczu, aby CS2 wysłało stan mapy.';
  else if (!fresh) hint = 'Pozycja pojawi się po nadejściu nowych danych.';
  else if (!correctMap && mapId(active.map)) hint = `CS2 zgłasza mapę ${nameForMap(mapId(active.map))}.`;
  else if (!visiblePlayers.length && !point) hint = 'CS2 nie udostępnia pozycji w tym widoku. Użyj widoku obserwatora, aby zobaczyć pozycje drużyn.';
  else if (!onLevel(player)) hint = 'Wybrany gracz jest na innym poziomie.';
  else if (point && !onMap(point)) hint = 'Pozycja poza granicami mapy. Sprawdź kalibrację.';
  $('radarHint').hidden = !hint;
  text('radarHint', hint);
  radar.draw({ image: image?.element, players: visiblePlayers, utility: visibleUtility, bounds, focusId: player?.id,
    names: $('names').checked, markerScale: $('markerScale').valueAsNumber, follow: $('follow').checked,
    stamp: demo ? performance.now() : active.updated,
    space: `${demo ? 'demo' : 'live'}:${active.round}:${activeKey}:${boundsFields.map(field => bounds[field]).join(',')}`,
  });
}

function retryConnection() {
  clearTimeout(retry);
  retry = setTimeout(connect, retryDelay);
  retryDelay = Math.min(8000, retryDelay * 2);
}

function connect() {
  clearTimeout(retry);
  const previous = socket;
  socket = null;
  previous?.close();
  const token = $('auth').value.trim();
  if (viewTokenRequired && !token) {
    connection = 'token';
    $('lanSettings').open = true;
    render();
    return;
  }
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) url.searchParams.set('token', token);
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () => {
    if (socket !== current) return;
    connection = 'open';
    retryDelay = 800;
    if (mapAccess === 'viewer') void syncSharedMap();
    render();
  };
  current.onmessage = event => {
    if (socket !== current) return;
    try {
      const incoming = JSON.parse(event.data);
      if (!incoming || !Array.isArray(incoming.players)) return;
      recordGrenadeTrails(incoming);
      live = { ...incoming, player: incoming.player ?? incoming.players[0] };
      serverAge = incoming.updated ? Math.max(0, (incoming.sentAt ?? Date.now()) - incoming.updated) : Infinity;
      receivedAt = performance.now();
      refreshMap();
      render();
    } catch {
      // The next valid WebSocket message will replace this one.
    }
  };
  current.onclose = async () => {
    if (socket !== current) return;
    connection = 'offline';
    render();
    if (viewTokenRequired) {
      try {
        const response = await fetch('/api/state', { headers: { 'x-view-token': token }, signal: AbortSignal.timeout(2500) });
        if (socket !== current) return;
        if (response.status === 401) {
          connection = 'denied';
          saveSessionToken('');
          $('lanSettings').open = true;
          render();
          return;
        }
      } catch {
        // A network interruption is retried below.
      }
    }
    if (socket === current) retryConnection();
  };
}

async function initializeConnection() {
  try {
    const response = await fetch('/health', { signal: AbortSignal.timeout(2500) });
    const reply = await response.json();
    viewTokenRequired = Boolean(reply.viewTokenRequired);
    $('lanSettings').hidden = !viewTokenRequired;
    viewOnly = Boolean(reply.viewOnly);
    if (viewOnly) {
      $('setup').hidden = true;
      mapAccess = 'viewer';
      $('mapFileWrap').hidden = true;
      $('calActions').hidden = true;
      $('removeImage').hidden = true;
      for (const field of boundsFields) $(field).readOnly = true;
    } else if (reply.manageMaps) {
      mapAccess = 'host';
      $('share').hidden = false;
    }
    if (mapAccess === 'host') void loadMapImage();
    void showReceiverStatus(reply);
  } catch {
    $('lanSettings').hidden = Boolean(setup);
  }
  connect();
}

function updateSetup(value) {
  if (!value) return;
  setupState = value;
  text('setupMessage', value.message);
  text('setupPath', value.path || '');
  $('setupPath').hidden = !value.path;
  text('setupDetail', value.detail || '');
  $('setupDetail').hidden = !value.detail;
  $('replace').hidden = value.state !== 'conflict';
  $('webReplace').hidden = value.state !== 'conflict';
  render();
}

async function setupAction(action) {
  if (setupBusy) return;
  setupBusy = true;
  const buttons = $('setupDialog').querySelectorAll('[data-gsi]');
  buttons.forEach(button => { button.disabled = true; });
  text('setupFeedback', '');
  if (action === 'detect') text('setupMessage', 'Szukam folderu Counter-Strike 2 w Steam…');
  try {
    const result = await setupControls[action]();
    if (action === 'save') {
      if (result.saved) text('setupFeedback', `Zapisano ${result.path}. Skopiuj plik do game/csgo/cfg i uruchom CS2 ponownie.`);
    } else {
      updateSetup(result);
      if (result?.backup && action === 'replace') text('setupFeedback', `Kopia: ${result.backup}`);
    }
  } catch {
    text('setupFeedback', 'Operacja się nie powiodła. Pobierz plik lub wybierz inny folder.');
  } finally {
    setupBusy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

for (const [id, map] of maps) $('mapSelect').add(new Option(map.name, id));
$('mapSelect').addEventListener('change', event => {
  selectedMap = event.target.value;
  autoMap = false;
  levelChoice = 'auto';
  refreshMap();
  render();
});
$('levelSelect').addEventListener('change', event => {
  levelChoice = event.target.value;
  refreshMap();
  render();
});
$('autoMap').addEventListener('click', () => {
  autoMap = true;
  levelChoice = 'auto';
  refreshMap();
  render();
});
$('zoomIn').addEventListener('click', () => radar.zoomBy(1.25));
$('zoomOut').addEventListener('click', () => radar.zoomBy(1 / 1.25));
$('reset').addEventListener('click', radar.reset);
$('center').addEventListener('click', radar.center);

$('demo').addEventListener('click', () => {
  focusId = undefined;
  demoStarted = demoStarted === null ? performance.now() : null;
  const demo = demoStarted !== null;
  $('demo').setAttribute('aria-pressed', String(demo));
  text('demo', demo ? 'Zakończ demo' : 'Tryb demo');
  refreshMap();
  render();
});

$('clearPlayer').addEventListener('click', () => focusPlayer(undefined));

function applyLargerMap(enabled) {
  $('dashboard').dataset.focus = String(enabled);
  $('focusMode').setAttribute('aria-pressed', String(enabled));
  text('focusMode', enabled ? 'Zwykły widok' : 'Większa mapa');
}

function persistView() {
  const values = Object.fromEntries(viewControls.map(id => {
    const control = $(id);
    return [id, control.type === 'checkbox' ? control.checked : control.value];
  }));
  try {
    localStorage.setItem('radar-view', JSON.stringify({ ...values, focus: $('dashboard').dataset.focus === 'true' }));
  } catch {
    // The view is still available during the current session.
  }
  render();
}

try {
  const prefs = JSON.parse(localStorage.getItem('radar-view'));
  for (const id of viewControls) {
    const control = $(id);
    if (control.type === 'checkbox' && typeof prefs?.[id] === 'boolean') control.checked = prefs[id];
    else if (control.type !== 'checkbox' && typeof prefs?.[id] === 'string') control.value = prefs[id];
  }
  if (!['all', 'CT', 'T'].includes($('teamFilter').value)) $('teamFilter').value = 'all';
  applyLargerMap(prefs?.focus === true);
} catch {
  // The defaults in the dashboard are safe after a storage error.
}
$('focusMode').addEventListener('click', () => {
  applyLargerMap($('dashboard').dataset.focus !== 'true');
  persistView();
});
for (const id of viewControls) $(id).addEventListener('input', persistView);

for (const id of boundsFields) $(id).addEventListener('input', () => { boundsDirty = true; render(); });
$('saveCal').addEventListener('click', async () => {
  const bounds = boundsFromForm();
  if (!validBounds(bounds)) return text('calStatus', 'Wprowadź cztery liczby. Wartość maksymalna musi być większa od minimalnej.');
  const key = activeKey;
  try {
    if (mapAccess === 'host') {
      await api.saveBounds(key, bounds);
      writeCalibration(key, null);
      if (key === activeKey) hostMap = { ...hostMap, bounds };
    } else writeCalibration(key, bounds);
    if (key === activeKey) {
      boundsDirty = false;
      text('calStatus', 'Kalibracja zapisana dla tej mapy i poziomu.');
    }
  } catch {
    if (key === activeKey) text('calStatus', 'Nie udało się zapisać kalibracji.');
  }
});
$('resetCal').addEventListener('click', async () => {
  const key = activeKey;
  try {
    if (mapAccess === 'host') await api.resetBounds(key);
    writeCalibration(key, null);
    if (key !== activeKey) return;
    boundsDirty = false;
    if (hostMap) hostMap.bounds = null;
    setBounds(defaultBounds(selectedMap));
    text('calStatus', 'Przywrócono domyślne granice.');
    render();
  } catch {
    if (key === activeKey) text('calStatus', 'Nie udało się przywrócić zapisanej kalibracji.');
  }
});

$('mapFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!allowedImageTypes.has(file.type) || file.size > 15 * 1024 * 1024) {
    return text('imageStatus', 'Wybierz plik PNG, JPG lub WebP do 15 MB.');
  }
  const key = activeKey;
  const request = ++imageRequest;
  text('imageStatus', 'Wczytuję grafikę…');
  let next;
  try {
    next = await decodeImage(file);
  } catch {
    if (request === imageRequest) text('imageStatus', 'Nie udało się otworzyć obrazu. Maksymalny wymiar to 8192 px.');
    return;
  }
  if (request !== imageRequest) return next.release();
  try {
    if (mapAccess === 'host') await api.saveImage(key, file);
    else await mapImage(key, file);
    if (request === imageRequest) return updateImage(next, true, `Zapisana grafika: ${file.name}`);
  } catch {
    if (request === imageRequest) text('imageStatus', 'Nie udało się zapisać grafiki mapy.');
  }
  next.release();
});

$('removeImage').addEventListener('click', async () => {
  if (!usingCustomImage || mapAccess === 'viewer') return;
  const key = activeKey;
  const request = ++imageRequest;
  try {
    if (mapAccess === 'host') await api.removeImage(key);
    await mapImage(key, null).catch(() => {});
    if (request === imageRequest) await loadMapImage(undefined, { keepBounds: true });
  } catch {
    if (request === imageRequest) text('imageStatus', 'Nie udało się usunąć zapisanej grafiki.');
  }
});

function saveSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(tokenKey, token);
    else sessionStorage.removeItem(tokenKey);
  } catch {
    // The current connection is still available if site storage is restricted.
  }
}

$('authForm').addEventListener('submit', event => {
  event.preventDefault();
  saveSessionToken($('auth').value.trim());
  connection = 'connecting';
  render();
  connect();
});

$('setupAddress').textContent = `http://127.0.0.1:${location.port || '80'}/gsi`;
$('desktopSetup').hidden = !setup;
$('browserSetup').hidden = Boolean(setup);
if (setup) {
  for (const [button, action] of [['detect', 'detect'], ['choose', 'choose'], ['replace', 'replace'], ['saveConfig', 'save']]) {
    $(button).addEventListener('click', () => setupAction(action));
  }
}
$('webDetect').addEventListener('click', () => void setupAction('detect'));
$('webReplace').addEventListener('click', () => void setupAction('replace'));
$('gameFolderForm').addEventListener('submit', event => {
  event.preventDefault();
  void setupAction('choose');
});

function activeRejection() {
  const recent = receiver?.rejection;
  return recent && recent.at > (live.updated || 0) && Date.now() - recent.at < 45_000
    ? gsiRejections[recent.reason] : '';
}

function waitingMessage() {
  if (viewOnly) return 'Host czeka na dane z CS2.';
  return activeRejection() || setupState?.message
    || (receiver?.setupAvailable ? 'Sprawdzam plik GSI w katalogu Steam.' : 'Wgraj plik GSI w sekcji konfiguracji i uruchom CS2 ponownie.');
}

async function showReceiverStatus(health) {
  if (receiverBusy || viewOnly) return;
  receiverBusy = true;
  try {
    const info = health ?? await (await fetch('/health', { signal: AbortSignal.timeout(2500) })).json();
    receiver = info.receiver;
    if (!receiver) return;
    $('webSetupControls').hidden = !receiver.setupAvailable;
    if (receiver.setupAvailable && !setupBusy) {
      const read = setup ? setup.status : api.gsiStatus;
      const current = await read();
      if (!setupBusy) updateSetup(current);
    } else if (!setupState) {
      text('setupMessage', 'Zapisz plik GSI w folderze CS2 i uruchom grę ponownie.');
    }
    const updated = info.updated || 0;
    const age = Date.now() - updated;
    let message = 'Serwer czeka na pierwszy pakiet z gry.';
    if (updated && age > staleAfter) message = 'Ostatni pakiet z gry dotarł wcześniej. Sprawdź aktywną instancję CS2.';
    else if (updated && receiver.observer) message = `Odebrano dane obserwatora · pozycje: ${receiver.positions}`;
    else if (updated && receiver.positions) message = 'Odebrano pozycję i telemetrię gracza.';
    else if (updated) message = 'Odebrano pakiet CS2. Wejdź do meczu, aby otrzymać stan mapy.';
    text('receiverStatus', activeRejection() || message);
    render();
  } catch {
    text('receiverStatus', 'Sprawdzanie połączenia z lokalnym serwerem…');
  } finally {
    receiverBusy = false;
  }
}

function openSetup() {
  $('setupDialog').showModal();
  void showReceiverStatus();
}
$('setup').addEventListener('click', openSetup);
$('waitingSetup').addEventListener('click', openSetup);
$('closeSetup').addEventListener('click', () => $('setupDialog').close());

function showSharing(info) {
  shareInfo = info;
  const picker = $('shareNetwork');
  const previous = picker.value;
  picker.replaceChildren(...info.addresses.map(entry => new Option(`${entry.name} · ${entry.ip}`, entry.ip)));
  if (info.addresses.some(entry => entry.ip === (info.ip || previous))) picker.value = info.ip || previous;
  const active = Boolean(info.link);
  picker.disabled = active;
  $('shareLink').value = info.link;
  $('shareLinkWrap').hidden = !active;
  $('copyShare').hidden = !active;
  $('stopShare').hidden = !active;
  $('startShare').hidden = active;
  $('share').setAttribute('aria-pressed', String(active));
  if (!info.addresses.length) text('shareFeedback', 'Połącz komputer z siecią lokalną IPv4.');
}

async function shareAction(action) {
  const controls = $('shareDialog').querySelectorAll('button:not(#closeShare)');
  controls.forEach(button => { button.disabled = true; });
  text('shareFeedback', '');
  try {
    if (action === 'shareCopy') {
      if (setup) {
        if (await setup.shareCopy()) text('shareFeedback', 'Skopiowano link.');
      } else {
        try {
          await navigator.clipboard.writeText(shareInfo.link);
          text('shareFeedback', 'Skopiowano link.');
        } catch {
          $('shareLink').select();
          text('shareFeedback', 'Zaznaczono link. Możesz go skopiować.');
        }
      }
    } else {
      const info = await sharingControls[action]($('shareNetwork').value);
      showSharing(info);
    }
  } catch {
    text('shareFeedback', 'Podgląd LAN jest niedostępny. Sprawdź połączenie sieciowe i spróbuj ponownie.');
  } finally {
    controls.forEach(button => { button.disabled = button.id === 'startShare' && !(shareInfo?.addresses.length); });
  }
}

$('share').addEventListener('click', () => {
  $('shareDialog').showModal();
  void shareAction('shareStatus');
});
for (const [button, action] of [['startShare', 'shareStart'], ['stopShare', 'shareStop'], ['copyShare', 'shareCopy']]) {
  $(button).addEventListener('click', () => void shareAction(action));
}
$('closeShare').addEventListener('click', () => $('shareDialog').close());

const sharedToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (sharedToken) {
  $('auth').value = sharedToken;
  saveSessionToken(sharedToken);
  history.replaceState(null, '', location.pathname + location.search);
} else {
  try { $('auth').value = sessionStorage.getItem(tokenKey) ?? ''; } catch { /* optional site storage */ }
}

fallbackInfo = fetch('/api/map-images').then(response => response.ok ? response.json() : []).catch(() => []);
refreshMap();
void initializeConnection();
render();
setInterval(render, 1000);
setInterval(() => {
  void syncSharedMap();
  if (!live.updated || $('setupDialog').open) void showReceiverStatus();
}, 2500);
setInterval(() => { if (demoStarted !== null) render(); }, 100);
