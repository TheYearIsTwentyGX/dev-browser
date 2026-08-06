const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowManager', {
    resize: (width, height) => ipcRenderer.send('resize-window', width, height)
});

contextBridge.exposeInMainWorld('portManager', {
    getActivePorts: (ports) => ipcRenderer.invoke('get-active-ports', ports)
});
