const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onLogPath: (cb) => ipcRenderer.on('log-path', (_e, p) => cb(p)),
  onLogEntry: (cb) => ipcRenderer.on('log-entry', (_e, obj) => cb(obj)),
  sendOrder: (payload) => ipcRenderer.invoke('action:order', payload)
});
