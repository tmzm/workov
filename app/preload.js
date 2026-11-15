// Gives the chat page a small, fixed set of calls. Nothing else of Node or Electron reaches the page.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const calls = ['say', 'answer', 'interrupt', 'setModel', 'setPermissionMode', 'pickFolder', 'pickFiles', 'newChat', 'sessions', 'resume', 'state', 'openDashboard', 'claude', 'claudeLogin', 'folders', 'setFolder'];
const api = {};
for (const c of calls) api[c] = (a) => ipcRenderer.invoke('chat:' + c, a);
api.pathOf = (file) => webUtils.getPathForFile(file);
api.on = (cb) => { ipcRenderer.on('chat:event', (_e, kind, data) => cb(kind, data)); };
contextBridge.exposeInMainWorld('fleetChat', api);
