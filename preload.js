const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winTouchBar', {
  getStatus: () => ipcRenderer.invoke('status'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (event, data) => callback(data));
  },
  onLogUpdate: (callback) => {
    ipcRenderer.on('log-update', (event, data) => callback(data));
  },
  // Local-only latency diagnostics (Electron host only)
  getDiagnostics: () => ipcRenderer.invoke('diag:get'),
  setDiagnostics: (enabled) => ipcRenderer.invoke('diag:set', enabled),
  clearDiagnostics: () => ipcRenderer.invoke('diag:clear'),
  copyText: (text) => ipcRenderer.invoke('diag:copy', text),
  onDiagnosticsUpdate: (callback) => {
    ipcRenderer.on('diag-update', (event, data) => callback(data));
  }
});