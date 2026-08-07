const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const net = require('net');
const { TitlesStore } = require('./titles-store');
const { ControlServer, DEFAULT_PORT } = require('./control-server');

let mainWindow;
let titlesStore;
let controlServer;

// Mirror of the renderer's tab state so GET /ports can answer synchronously
// instead of round-tripping into the renderer inside an HTTP handler.
let rendererState = { openTabs: [], selectedPort: null, detectedPorts: [] };

// DevTools shortcuts.
//
// before-input-event only fires on the webContents that currently has focus, and a
// <webview> is a separate webContents from the window that hosts it. Listening on
// the window alone therefore missed every keypress the moment a tab was focused,
// which is most of the time. Registering through web-contents-created instead
// covers the shell and every guest page. This runs at module load, before any
// webContents exists, so nothing is missed.
app.on('web-contents-created', (_event, contents) => {
    contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;

        // This runs for every keystroke in every page, so it must never throw
        const key = typeof input.key === 'string' ? input.key : '';
        const isF12 = key === 'F12';
        const isInspect = input.control && input.shift && key.toLowerCase() === 'i';
        if (!isF12 && !isInspect) return;

        // Inspect the page actually being looked at, the way a browser would.
        // Keypresses on the dashboard or sidebar fall through to the shell.
        const target = contents.getType() === 'webview'
            ? contents
            : (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : contents);

        if (target.isDevToolsOpened()) {
            target.closeDevTools();
        } else {
            target.openDevTools();
        }
        event.preventDefault();
    });
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true, // Required for <webview> tags
            preload: path.join(__dirname, 'preload.js')
        },
        backgroundColor: '#0F0F12',
        title: "Dev Browser - Windows Desktop"
    });

    mainWindow.loadFile('index.html');

    // Handle window closure cleanup
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Push the current titles to the renderer, if there is one listening.
function broadcastTitles(titles) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('titles-changed', titles);
    }
}

// Forward a remote tab command to the renderer, which owns the webviews.
function dispatchCommand(command) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'DevBrowser window is not available' };
    }
    mainWindow.webContents.send('remote-command', command);
    // Bring the window forward so an agent-driven "open" is actually seen.
    if (command.action === 'open' && command.select !== false) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
    }
    return { ok: true, dispatched: command };
}

function startControlChannel() {
    titlesStore = new TitlesStore(path.join(app.getPath('userData'), 'titles.json'));
    titlesStore.load();
    // Picks up titles written directly to the file while the app was closed or by hand.
    titlesStore.startWatching();
    titlesStore.on('changed', broadcastTitles);

    controlServer = new ControlServer({
        port: DEFAULT_PORT,
        discoveryPath: path.join(app.getPath('userData'), 'control-server.json'),
        version: app.getVersion(),
        handlers: {
            getTitles: () => titlesStore.getAll(),
            setTitle: (port, title) => titlesStore.set(port, title),
            clearTitle: (port) => titlesStore.clear(port),
            setTitles: (map) => titlesStore.setMany(map),
            getPorts: () => ({
                detected: rendererState.detectedPorts,
                open: rendererState.openTabs,
                selected: rendererState.selectedPort,
                titles: titlesStore.getAll()
            }),
            sendCommand: dispatchCommand
        }
    });

    // A failed control server must not take the browser down with it.
    controlServer.start().catch((err) => {
        console.error('[main] control channel disabled:', err.message);
    });
}

app.whenReady().then(() => {
    createWindow();
    startControlChannel();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    if (titlesStore) titlesStore.stopWatching();
    if (controlServer) controlServer.stop();
});

// IPC Handler to resize the OS Window
ipcMain.on('resize-window', (event, width, height) => {
    if (mainWindow) {
        mainWindow.setSize(width, height);
        mainWindow.center(); // Center the window after resizing
    }
});

// Helper to check if a specific port is listening on localhost
function checkPortListening(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(250); // 250ms is plenty for localhost
        
        socket.on('connect', () => {
            socket.destroy();
            resolve(true); // Connected successfully! Port is active
        });
        
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        
        socket.connect(port, '127.0.0.1');
    });
}

// IPC Handler to query active localhost ports by attempting TCP connects
ipcMain.handle('get-active-ports', async (event, portsToScan) => {
    if (!portsToScan || !Array.isArray(portsToScan)) return [];

    // Never report our own control server as a discovered dev server
    const controlPort = controlServer ? controlServer.port : null;

    // Scan up to 100 ports concurrently to avoid overwhelming the network stack
    const ports = portsToScan.slice(0, 100).filter(p => p !== controlPort);
    const results = await Promise.all(ports.map(async (port) => {
        const isListening = await checkPortListening(port);
        return isListening ? port : null;
    }));

    return results.filter(p => p !== null);
});

// IPC Handler for the renderer's initial title load
ipcMain.handle('get-titles', () => (titlesStore ? titlesStore.getAll() : {}));

// The renderer owns tab state, so it reports changes up for the control server to read
ipcMain.on('state-sync', (event, state) => {
    if (!state || typeof state !== 'object') return;
    rendererState = {
        openTabs: Array.isArray(state.openTabs) ? state.openTabs : [],
        selectedPort: typeof state.selectedPort === 'number' ? state.selectedPort : null,
        detectedPorts: Array.isArray(state.detectedPorts) ? state.detectedPorts : []
    };
});
