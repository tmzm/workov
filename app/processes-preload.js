'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fleetProcesses', {
  list: () => ipcRenderer.invoke('proc:list'),
  stop: (pid, start) => ipcRenderer.invoke('proc:stop', pid, start),
});
