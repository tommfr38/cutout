const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bench', {
  infer: (req) => ipcRenderer.invoke('infer', req),
  save: (rel, data) => ipcRenderer.invoke('save', rel, data),
  list: (dir) => ipcRenderer.invoke('list', dir),
  log: (s) => ipcRenderer.send('log', s),
  done: () => ipcRenderer.send('done'),
});
