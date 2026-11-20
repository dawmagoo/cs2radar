'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { bindLocalRadar, createRadarServer } = require('./server');
const { createGsiSetup } = require('./gsi-setup');
const { configName, renderGsiConfig } = require('./steam');

let window;
let radar;
let url;
let port;
let settings;
let settingsPath;
let gsiSetup;

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

  handle('setup:status', gsiSetup.status);
  handle('setup:detect', gsiSetup.detect);

  handle('setup:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Wybierz folder instalacji CS2',
      defaultPath: settings.configDir || app.getPath('home'),
      properties: ['openDirectory'],
    });
    return result.canceled ? gsiSetup.status() : gsiSetup.choose(result.filePaths[0]);
  });

  handle('setup:replace', async () => {
    const current = gsiSetup.status();
    if (current.state !== 'conflict') return current;
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Zastąp konfigurację WebRadar',
      message: 'Zastąpić plik GSI aktualną konfiguracją?',
      detail: `${current.path}\n\nKopia dotychczasowego pliku zostanie obok w folderze cfg.`,
      buttons: ['Zachowaj plik', 'Zastąp i zapisz kopię'],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1 ? gsiSetup.replace() : current;
  });

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
  port = await bindLocalRadar(radar, settings.preferredPort);
  settings.preferredPort = port;
  await saveSettings();
  gsiSetup = createGsiSetup({
    port, token: settings.token, preferred: settings.configDir,
    remember: async directory => {
      if (settings.configDir === directory) return;
      settings.configDir = directory;
      await saveSettings();
    },
  });
  radar.attachGsiSetup(gsiSetup);

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
  void (process.env.CS2_PATH ? gsiSetup.choose(process.env.CS2_PATH) : gsiSetup.detect());
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
