'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fleetAbout', { version: () => ipcRenderer.invoke('about:version') });
