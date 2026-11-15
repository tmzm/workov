// Preload of the dashboard window. It tells the page it is inside the desktop app (which shows the Chat tab) and lets the
// page place or hide the chat view. main.js only honours these calls from the dashboard page on 127.0.0.1.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fleetShell', {
  chatShow: (rect) => ipcRenderer.invoke('shell:chatShow', rect),
  chatHide: () => ipcRenderer.invoke('shell:chatHide'),
  chatTheme: (s) => ipcRenderer.invoke('shell:chatTheme', s),
});
