'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRadarServer } = require('./server');
const { configName, findConfigDirectory, installGsiConfig, renderGsiConfig, resolveConfigDirectory } = require('./steam');

let window;
let radar;
let url;
let port;
let settings;
let settingsPath;
let setupTask;
let setupStatus;

async function readSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    return {
      token: typeof saved?.token === 'string' && /^[a-f0-9]{64}$/.test(saved.token) ? saved.token : randomBytes(32).toString('hex'),
      preferredPort: Number.isInteger(saved?.preferredPort) && saved.preferredPort >= 3000 && saved.preferredPort <= 3010 ? saved.preferredPort : 3000,
      configDir: typeof saved?.configDir === 'string' ? saved.configDir : '',
    };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return { token: randomBytes(32).toString('hex'), preferredPort: 3000, configDir: '' };
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(temporary, settingsPath);
}

async function bindRadar() {
  const candidates = new Set([settings.preferredPort, 3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010]);
  for (const candidate of candidates) {
    try {
      return await radar.listen(candidate);
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Nie udało się uruchomić radaru na portach od 3000 do 3010. Zwolnij jeden z portów i uruchom aplikację ponownie.');
}

const messages = {
  ready: 'Plik GSI jest w katalogu CS2. Uruchom grę, aby zobaczyć dane.',
  restart: 'Plik GSI jest gotowy. Uruchom lub zrestartuj CS2.',
  conflict: 'W tym katalogu jest zmieniony plik WebRadar. Możesz zastąpić go z zachowaniem kopii.',
  missing: 'Nie znaleziono CS2. Wybierz folder gry w aplikacji albo zapisz plik GSI ręcznie.',
  invalid: 'Wybierz folder instalacji CS2 zawierający game/csgo/cfg lub sam folder cfg.',
  error: 'Nie można zapisać pliku GSI. Zapisz go ręcznie i skopiuj do game/csgo/cfg.',
};

function status(state, fields = {}) {
  return { state, message: messages[state], port, ...fields };
}

async function installIn(directory, options) {
  try {
    const result = await installGsiConfig(directory, port, settings.token, options);
    settings.configDir = directory;
    await saveSettings();
    return status(result.state, result);
  } catch (error) {
    console.error('GSI setup:', error);
    return status('error', { path: path.join(directory, configName) });
  }
}

function startSetup(action) {
  if (!setupTask) {
    setupTask = Promise.resolve().then(action).then(result => {
      if (result) setupStatus = result;
      return setupStatus;
    }).catch(error => {
      console.error('GSI setup:', error);
      setupStatus = status('error');
      return setupStatus;
    }).finally(() => {
      setupTask = null;
    });
  }
  return setupTask;
}

function autoSetup() {
  return startSetup(async () => {
    const directory = await findConfigDirectory(settings.configDir);
    return directory ? installIn(directory) : status('missing');
  });
}

function registerSetupHandlers() {
  function handle(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== url || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Nieprawidłowe źródło żądania.');
      }
      return handler(...args);
    });
  }

  handle('share:status', radar.sharing.status);
  handle('share:start', radar.sharing.start);
  handle('share:stop', radar.sharing.stop);
  handle('share:copy', () => {
    const { link } = radar.sharing.status();
    if (!link) return false;
    clipboard.writeText(link);
    return true;
  });

  handle('setup:status', () => setupTask ?? setupStatus);
  handle('setup:detect', autoSetup);

  handle('setup:choose', () => startSetup(async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Wybierz folder instalacji CS2',
      defaultPath: settings.configDir || app.getPath('home'),
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const directory = await resolveConfigDirectory(result.filePaths[0]);
    return directory ? installIn(directory) : status('invalid');
  }));

  handle('setup:replace', () => startSetup(async () => {
    if (setupStatus?.state !== 'conflict') return null;
    const directory = await resolveConfigDirectory(settings.configDir);
    if (!directory) return status('missing');
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Zastąp konfigurację WebRadar',
      message: 'Zastąpić plik GSI aktualną konfiguracją?',
      detail: `${setupStatus.path}\n\nKopia dotychczasowego pliku zostanie obok w folderze cfg.`,
      buttons: ['Zachowaj plik', 'Zastąp i zapisz kopię'],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1 ? installIn(directory, { replace: true }) : null;
  }));

  handle('setup:save', async () => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Zapisz konfigurację GSI',
      defaultPath: path.join(app.getPath('downloads'), configName),
      filters: [{ name: 'Konfiguracja CS2', extensions: ['cfg'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.writeFile(result.filePath, renderGsiConfig(port, settings.token));
    return { saved: true, path: result.filePath };
  });
}

async function main() {
  app.setAppUserModelId('pl.cs2webradar.desktop');
  Menu.setApplicationMenu(null);
  settingsPath = path.join(app.getPath('userData'), 'desktop.json');
  settings = await readSettings();
  radar = createRadarServer({ gsiToken: settings.token });
  port = await bindRadar();
  settings.preferredPort = port;
  await saveSettings();

  url = `http://127.0.0.1:${port}/`;
  window = new BrowserWindow({
    title: 'CS2 WebRadar',
    width: 1280,
    height: 930,
    minWidth: 410,
    minHeight: 560,
    backgroundColor: '#101619',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((source, permission, allow) => allow(false));
  contents.session.setPermissionCheckHandler(() => false);
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
  registerSetupHandlers();
  autoSetup();
  await window.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => radar?.close());
  app.whenReady().then(main).catch(error => {
    console.error(error);
    dialog.showErrorBox('CS2 WebRadar', `Nie udało się uruchomić aplikacji.\n\n${error.message}`);
    app.quit();
  });
}
