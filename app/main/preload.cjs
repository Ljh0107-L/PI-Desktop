const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pidesk', {
  invoke: (method, ...args) => ipcRenderer.invoke('pidesk:invoke', method, ...args),
  // Absolute path of a dropped or picked file ('' for pasted data).
  pathForFile: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  subscribe(listener) {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('pidesk:event', handler);
    return () => ipcRenderer.removeListener('pidesk:event', handler);
  },
});
