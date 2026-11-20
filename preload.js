'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webRadarSetup', {
  status: () => ipcRenderer.invoke('setup:status'),
  detect: () => ipcRenderer.invoke('setup:detect'),
  choose: () => ipcRenderer.invoke('setup:choose'),
  replace: () => ipcRenderer.invoke('setup:replace'),
  save: () => ipcRenderer.invoke('setup:save'),
  shareStatus: () => ipcRenderer.invoke('share:status'),
  shareStart: ip => ipcRenderer.invoke('share:start', ip),
  shareStop: () => ipcRenderer.invoke('share:stop'),
  shareCopy: () => ipcRenderer.invoke('share:copy'),
});
