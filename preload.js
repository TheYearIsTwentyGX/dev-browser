const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowManager', {
    resize: (width, height) => ipcRenderer.send('resize-window', width, height)
});

contextBridge.exposeInMainWorld('portManager', {
    getActivePorts: (ports) => ipcRenderer.invoke('get-active-ports', ports)
});

// Bridge for the agent control channel: friendly port titles and remote tab commands.
contextBridge.exposeInMainWorld('devBrowser', {
    getTitles: () => ipcRenderer.invoke('get-titles'),
    onTitlesChanged: (callback) => ipcRenderer.on('titles-changed', (_event, titles) => callback(titles)),
    onRemoteCommand: (callback) => ipcRenderer.on('remote-command', (_event, command) => callback(command)),
    syncState: (state) => ipcRenderer.send('state-sync', state)
});
