const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const net = require('net');

let mainWindow;

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

    // Toggle DevTools when F12 is pressed (handles focus inside webviews)
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    // Handle window closure cleanup
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
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
    
    // Scan up to 100 ports concurrently to avoid overwhelming the network stack
    const ports = portsToScan.slice(0, 100); 
    const results = await Promise.all(ports.map(async (port) => {
        const isListening = await checkPortListening(port);
        return isListening ? port : null;
    }));
    
    return results.filter(p => p !== null);
});
