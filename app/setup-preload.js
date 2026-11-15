// Preload of the first-run setup window: a fixed set of calls, nothing else of Node or Electron reaches the page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const c of ['checks', 'claudeLogin', 'pickFleet', 'open', 'testNotification', 'done']) api[c] = (a) => ipcRenderer.invoke('setup:' + c, a);
contextBridge.exposeInMainWorld('fleetSetup', api);
