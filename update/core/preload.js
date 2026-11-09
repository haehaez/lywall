const { contextBridge, webUtils, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // caminho completo do arquivo (usado pelos presets)
  pathOf: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch (e) { return null; }
  },
  // atualizações
  appVersion: () => ipcRenderer.invoke('update:version'),
  appInfo: () => ipcRenderer.invoke('update:info'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  // qualidade do vídeo
  makeProxy: (id, path, height) => ipcRenderer.invoke('proxy:start', { id, path, height }),
  cancelProxy: (id) => ipcRenderer.invoke('proxy:cancel', id),
  onProxyProgress: (cb) => ipcRenderer.on('proxy:progress', (_e, d) => cb(d)),
  onUpdateInvalid: (cb) => ipcRenderer.on('update:invalid', (_e, info) => cb(info)),
  onUpdate: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
});
