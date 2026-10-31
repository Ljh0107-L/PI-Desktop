const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pidesk', {
  invoke: (method, ...args) => ipcRenderer.invoke('pidesk:invoke', method, ...args),
  subscribe(listener) {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('pidesk:event', handler);
    return () => ipcRenderer.removeListener('pidesk:event', handler);
  },
});
