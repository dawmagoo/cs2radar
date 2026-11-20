import {
  boundsFields, decodeImage, defaultBounds, mapId, mapImage, maps, readCalibration, validBounds, writeCalibration,
} from './maps.js';
import { createRadar, onMap, project } from './radar.js';
import { demoState } from './demo.js';

const $ = id => document.getElementById(id);
const dash = '—';
const setup = window.webRadarSetup;
const staleAfter = 40_000;
const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const phases = { live: 'w toku', freezetime: 'zakupy', over: 'koniec rundy', warmup: 'rozgrzewka', gameover: 'koniec meczu', bomb: 'podłożona bomba', defuse: 'rozbrajanie', paused: 'pauza', halftime: 'przerwa' };
const bombs = { carried: 'Bomba niesiona', dropped: 'Bomba na ziemi', planting: 'Podkładanie bomby', planted: 'Bomba podłożona', defusing: 'Rozbrajanie bomby', defused: 'Bomba rozbrojona', exploded: 'Bomba eksplodowała' };
const equipmentNames = { smokegrenade: 'Dym', flashbang: 'Flash', hegrenade: 'HE', molotov: 'Mołotow', incgrenade: 'Zapalający', decoy: 'Wabik' };
const viewControls = ['teamFilter', 'markerScale', 'names', 'utility', 'follow'];
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

function text(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}

function boundsFromForm() {
  return Object.fromEntries(boundsFields.map(id => [id, $(id).valueAsNumber]));
}

function currentBounds() {
  const tentative = boundsFromForm();
  return validBounds(tentative) ? tentative : readCalibration(activeKey, selectedMap);
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
  $('removeImage').hidden = !custom;
  text('imageMode', image ? 'Grafika mapy' : 'Siatka współrzędnych');
  text('imageStatus', message);
  render();
}

async function loadMapImage() {
  const request = ++imageRequest;
  const key = activeKey;
  const file = `${selectedMap}${maps.get(selectedMap)?.lowerBelow !== undefined ? `_${level}` : ''}.png`;
  updateImage(null, false, 'Sprawdzam zapisaną grafikę…');
  try {
    const stored = await mapImage(key);
    if (stored) {
      const next = await decodeImage(stored);
      if (request !== imageRequest) return next.release();
      return updateImage(next, true, `Zapisana grafika: ${stored.name || 'obraz mapy'}`);
    }
  } catch {
    // A missing or unreadable browser record leaves the bundled map available.
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
  if (request === imageRequest) updateImage(null, false, 'Dodaj własny obraz PNG, JPG lub WebP (do 15 MB).');
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
  setBounds(readCalibration(key, selectedMap));
  $('mapFile').value = '';
  text('calStatus', '');
  radar.reset();
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
    visibleUtility.push(...(active.grenades || []).filter(onLevel));
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
  $('sourceTag').hidden = demo || !active.observer;
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

  let hint = '';
  if (!demo && authNeeded) hint = 'Wpisz token w sekcji Dostęp LAN.';
  else if (!demo && !live.updated) hint = 'Uruchom CS2 z włączonym GSI lub wypróbuj tryb demo.';
  else if (!fresh) hint = 'Pozycja pojawi się po nadejściu nowych danych.';
  else if (!correctMap && mapId(active.map)) hint = `CS2 zgłasza mapę ${nameForMap(mapId(active.map))}.`;
  else if (!visiblePlayers.length && !point) hint = 'CS2 nie udostępnia pozycji w tym widoku.';
  else if (!onLevel(player)) hint = 'Wybrany gracz jest na innym poziomie.';
  else if (point && !onMap(point)) hint = 'Pozycja poza granicami mapy. Sprawdź kalibrację.';
  $('radarHint').hidden = !hint;
  text('radarHint', hint);
  radar.draw({ image: image?.element, players: visiblePlayers, utility: visibleUtility, bounds, focusId: player?.id,
    names: $('names').checked, markerScale: $('markerScale').valueAsNumber, follow: $('follow').checked });
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
    render();
  };
  current.onmessage = event => {
    if (socket !== current) return;
    try {
      const incoming = JSON.parse(event.data);
      if (!incoming || !Array.isArray(incoming.players)) return;
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
    if (reply.viewOnly) $('setup').hidden = true;
  } catch {
    $('lanSettings').hidden = Boolean(setup);
  }
  connect();
}

function updateSetup(value) {
  if (!value) return;
  text('setupMessage', value.message);
  text('setupPath', value.path || '');
  $('setupPath').hidden = !value.path;
  $('replace').hidden = value.state !== 'conflict';
}

async function setupAction(action) {
  const buttons = $('desktopSetup').querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  text('setupFeedback', '');
  try {
    const result = await setup[action]();
    if (action === 'save') {
      if (result.saved) text('setupFeedback', `Zapisano ${result.path}. Skopiuj plik do game/csgo/cfg i zrestartuj CS2.`);
    } else {
      updateSetup(result);
      if (result?.backup && action === 'replace') text('setupFeedback', `Kopia: ${result.backup}`);
    }
  } catch {
    text('setupFeedback', 'Operacja się nie powiodła. Spróbuj ponownie lub zapisz plik w innym folderze.');
  } finally {
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

for (const id of boundsFields) $(id).addEventListener('input', render);
$('saveCal').addEventListener('click', () => {
  const bounds = boundsFromForm();
  if (!validBounds(bounds)) return text('calStatus', 'Wprowadź cztery liczby. Wartość maksymalna musi być większa od minimalnej.');
  try {
    writeCalibration(activeKey, bounds);
    text('calStatus', 'Kalibracja zapisana dla tej mapy i poziomu.');
  } catch {
    text('calStatus', 'Przeglądarka nie pozwoliła zapisać kalibracji.');
  }
});
$('resetCal').addEventListener('click', () => {
  try {
    writeCalibration(activeKey, null);
    setBounds(defaultBounds(selectedMap));
    text('calStatus', 'Przywrócono domyślne granice.');
    render();
  } catch {
    text('calStatus', 'Nie udało się przywrócić zapisanej kalibracji.');
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
  const existing = image;
  text('imageStatus', 'Wczytuję grafikę…');
  let next;
  try {
    next = await decodeImage(file);
  } catch {
    if (request === imageRequest) {
      if (!existing) await loadMapImage();
      text('imageStatus', 'Nie udało się otworzyć obrazu. Maksymalny wymiar to 8192 px.');
    }
    return;
  }
  if (request !== imageRequest) return next.release();
  let saved = true;
  try {
    await mapImage(key, file);
  } catch {
    saved = false;
  }
  if (request === imageRequest) {
    updateImage(next, true, saved ? `Zapisana grafika: ${file.name}` : 'Grafika jest dostępna do odświeżenia strony.');
  } else {
    next.release();
  }
});

$('removeImage').addEventListener('click', async () => {
  if (!usingCustomImage) return;
  const key = activeKey;
  const request = ++imageRequest;
  try {
    await mapImage(key, null);
    if (request === imageRequest) await loadMapImage();
  } catch {
    if (request === imageRequest) text('imageStatus', 'Nie udało się usunąć zapisanej grafiki.');
  }
});

$('authForm').addEventListener('submit', event => {
  event.preventDefault();
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
  void setupAction('status');
} else {
  text('setupMessage', 'Skonfiguruj grę plikiem GSI. Podgląd pojawi się po odebraniu pierwszego komunikatu.');
}
$('setup').addEventListener('click', () => $('setupDialog').showModal());
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
      if (await setup.shareCopy()) text('shareFeedback', 'Skopiowano link.');
    } else {
      const info = await setup[action]($('shareNetwork').value);
      showSharing(info);
    }
  } catch {
    text('shareFeedback', 'Podgląd LAN jest niedostępny. Sprawdź połączenie sieciowe i spróbuj ponownie.');
  } finally {
    controls.forEach(button => { button.disabled = button.id === 'startShare' && !(shareInfo?.addresses.length); });
  }
}

if (setup) {
  $('share').hidden = false;
  $('share').addEventListener('click', () => {
    $('shareDialog').showModal();
    void shareAction('shareStatus');
  });
  for (const [button, action] of [['startShare', 'shareStart'], ['stopShare', 'shareStop'], ['copyShare', 'shareCopy']]) {
    $(button).addEventListener('click', () => void shareAction(action));
  }
}
$('closeShare').addEventListener('click', () => $('shareDialog').close());

const sharedToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (sharedToken) {
  $('auth').value = sharedToken;
  history.replaceState(null, '', location.pathname + location.search);
}

fallbackInfo = fetch('/api/map-images').then(response => response.ok ? response.json() : []).catch(() => []);
refreshMap();
void initializeConnection();
render();
setInterval(render, 1000);
setInterval(() => { if (demoStarted !== null) render(); }, 100);
