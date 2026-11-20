'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webRadarDesktop', {
  captureSources: () => ipcRenderer.invoke('capture:sources'),
  selectCapture: id => ipcRenderer.invoke('capture:select', id),
  shareStatus: () => ipcRenderer.invoke('share:status'),
  shareStart: ip => ipcRenderer.invoke('share:start', ip),
  shareStop: () => ipcRenderer.invoke('share:stop'),
  shareCopy: () => ipcRenderer.invoke('share:copy'),
});
