'use strict';

const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu } = require('electron');
const path = require('node:path');
const { bindLocalRadar, createRadarServer } = require('./server');

let window;
let radar;

function configureWindow(contents, url) {
  const origin = new URL(url).origin;
  const isDashboardOrigin = value => value === origin || value === url;
  const session = contents.session;
  let sources = new Map();
  let selection;

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());

  const validSelection = () => selection && selection.expires > Date.now();
  session.setPermissionRequestHandler((sender, permission, respond) => {
    respond(Boolean(sender === contents && permission === 'display-capture' && validSelection()));
  });
  session.setPermissionCheckHandler((sender, permission, requestingOrigin) =>
    Boolean(sender === contents && permission === 'display-capture' && isDashboardOrigin(requestingOrigin) && validSelection()));
  session.setDisplayMediaRequestHandler((request, respond) => {
    const selected = validSelection() ? selection.source : null;
    selection = null;
    if (selected && request.frame === contents.mainFrame && isDashboardOrigin(request.securityOrigin)
      && request.userGesture && request.videoRequested && !request.audioRequested) {
      respond({ video: selected });
    } else {
      respond(null);
    }
  });

  function handle(channel, action) {
    ipcMain.handle(channel, (event, ...values) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame?.url !== url) {
        throw new Error('Nieprawidłowe źródło żądania.');
      }
      return action(...values);
    });
  }

  handle('capture:sources', async () => {
    selection = null;
    const available = await desktopCapturer.getSources({
      types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 },
    });
    const ownWindow = contents.getMediaSourceId();
    const ordered = available.filter(source => source.id !== ownWindow && source.name !== 'CS2 WebRadar')
      .sort((a, b) => Number(/counter-strike 2/i.test(b.name)) - Number(/counter-strike 2/i.test(a.name)));
    sources = new Map(ordered.map(source => [source.id, source]));
    return ordered.map(({ id, name }) => ({ id, name }));
  });
  handle('capture:select', id => {
    const source = sources.get(id);
    sources.clear();
    if (!source) return false;
    selection = { source, expires: Date.now() + 15_000 };
    return true;
  });

  handle('share:status', radar.sharing.status);
  handle('share:start', radar.sharing.start);
  handle('share:stop', radar.sharing.stop);
  handle('share:copy', () => {
    const { link } = radar.sharing.status();
    if (!link) return false;
    clipboard.writeText(link);
    return true;
  });
}

async function main() {
  app.setAppUserModelId('pl.cs2webradar.desktop');
  Menu.setApplicationMenu(null);
  radar = createRadarServer({ gsiToken: process.env.GSI_TOKEN || '' });
  const port = await bindLocalRadar(radar);
  const url = `http://127.0.0.1:${port}/`;
  window = new BrowserWindow({
    title: 'CS2 WebRadar',
    width: 1360,
    height: 900,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#161b22',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  configureWindow(window.webContents, url);
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
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
