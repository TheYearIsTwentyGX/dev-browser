// State Management
let openTabs = [];
let selectedPort = null;
let activeDetectedPorts = [];
let currentDeviceWidth = 0;
let currentDeviceHeight = 0;
let isLandscape = false;
// Friendly names keyed by port, set by agents through the control channel
let portTitles = {};

// DOM Elements
const webviewContainer = document.getElementById('webview-container');
const quickPortsGrid = document.getElementById('quick-ports-grid');
const customPortInput = document.getElementById('custom-port-input');
const openCustomPortBtn = document.getElementById('open-custom-port-btn');
const newRangeInput = document.getElementById('new-range-input');
const addRangeBtn = document.getElementById('add-range-btn');
const rangesList = document.getElementById('ranges-list');
const toggleConfigBtn = document.getElementById('toggle-config-btn');
const configEditor = document.getElementById('config-editor');
const detectedPortsList = document.getElementById('detected-ports-list');
const dashboardLanding = document.getElementById('dashboard-landing');
const browserView = document.getElementById('browser-view');
const webHomeBtn = document.getElementById('web-home-btn');
const addressHost = document.getElementById('address-host');
const addressTitle = document.getElementById('address-title');
const addressPathInput = document.getElementById('address-path-input');
const controlPanel = document.getElementById('control-panel');
const collapseSidebarBtn = document.getElementById('collapse-sidebar-btn');

// Browser Buttons
const webBackBtn = document.getElementById('web-back-btn');
const webForwardBtn = document.getElementById('web-forward-btn');
const webRefreshBtn = document.getElementById('web-refresh-btn');

// Resizing Elements
const deviceWrapper = document.getElementById('device-wrapper');
const orientationBtn = document.getElementById('orientation-btn');
const dimensionsBadge = document.getElementById('dimensions-badge');
const resizerButtons = document.querySelectorAll('.resizer-btn');

// --- 1. Init & SharedPreferences Settings equivalent ---
function loadRanges() {
    let ranges = JSON.parse(localStorage.getItem('port-ranges'));
    if (!ranges || !Array.isArray(ranges)) {
        ranges = ["5000-5060"];
        localStorage.setItem('port-ranges', JSON.stringify(ranges));
    }
    return ranges;
}

function saveRanges(ranges) {
    localStorage.setItem('port-ranges', JSON.stringify(ranges));
    renderConfigEditor();
    renderPortsGrid();
}

function parseRanges(ranges) {
    const ports = [];
    for (const rangeStr of ranges) {
        const clean = rangeStr.trim();
        if (!clean) continue;
        if (clean.includes('-')) {
            const parts = clean.split('-');
            if (parts.length === 2) {
                const start = parseInt(parts[0], 10);
                const end = parseInt(parts[1], 10);
                if (!isNaN(start) && !isNaN(end) && start <= end) {
                    for (let p = start; p <= end; p++) {
                        if (p >= 1 && p <= 65535) ports.push(p);
                    }
                }
            }
        } else {
            const p = parseInt(clean, 10);
            if (!isNaN(p) && p >= 1 && p <= 65535) {
                ports.push(p);
            }
        }
    }
    return Array.from(new Set(ports)).sort((a, b) => a - b);
}

// --- 1b. Port Titles (set remotely by agents) ---

function titleFor(port) {
    return portTitles[String(port)] || null;
}

// Titles arrive from outside the app, so escape before any innerHTML use
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

// --- 1c. Collapsed-rail hover popover ---

// When the sidebar is collapsed there is only ~60px of card, so titles are hidden.
// This shows them instantly on hover instead of waiting on a native tooltip.
const portPopover = document.getElementById('port-popover');
const popoverTitleEl = document.createElement('span');
const popoverPortEl = document.createElement('span');
popoverTitleEl.className = 'popover-title';
popoverPortEl.className = 'popover-port';
if (portPopover) {
    portPopover.appendChild(popoverTitleEl);
    portPopover.appendChild(popoverPortEl);
}

// Leaving a port button does not hide the popover straight away. Sliding from one
// port to the next crosses the gap between them, and hiding on that gap would
// start a fade-out the next hover has to undo — which is what made moving down
// the rail feel sluggish. A short grace period lets the next hover cancel it.
const POPOVER_HIDE_GRACE_MS = 120;
let popoverHideTimer = null;

function isSidebarCollapsed() {
    return controlPanel.classList.contains('collapsed');
}

function showPortPopover(anchor, port, title) {
    if (!portPopover || !title || !isSidebarCollapsed()) return;

    // Cancel a hide left pending from the port we just came off
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;

    // Already up? Then this is a move between ports: swap contents and position
    // with the fade switched off so the new title appears with no animation.
    portPopover.classList.toggle('instant', portPopover.classList.contains('visible'));

    // Titles come from agents, so assign as text and never as markup
    popoverTitleEl.textContent = title;
    popoverPortEl.textContent = `localhost:${port}`;

    const rect = anchor.getBoundingClientRect();
    const margin = 8;

    // Hang off the rail's edge, not the card's: cards are inset by the rail
    // padding, so anchoring to the card would overlap the sidebar border
    const left = controlPanel.getBoundingClientRect().right + 10;
    portPopover.style.left = `${left}px`;

    // Widen to fit the title, capped only by the room left in the window. Long
    // names wrap instead of truncating, so this must be applied before the
    // height is measured.
    portPopover.style.maxWidth = `${Math.max(120, window.innerWidth - left - margin)}px`;

    // visibility:hidden still reports layout, so this measures the final size
    const height = portPopover.offsetHeight;
    let top = rect.top + (rect.height - height) / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    portPopover.style.top = `${top}px`;
    // Keep the caret aimed at the card even when the popover is clamped to the viewport
    portPopover.style.setProperty('--caret-top', `${rect.top + rect.height / 2 - top}px`);

    portPopover.classList.add('visible');
    portPopover.setAttribute('aria-hidden', 'false');
}

// Drop it now, with no grace period — for when the anchor itself is going away
function hidePortPopoverNow() {
    if (!portPopover) return;
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
    portPopover.classList.remove('visible', 'instant');
    portPopover.setAttribute('aria-hidden', 'true');
}

// Leaving a port button: hold briefly so a hover on the next port can cancel it
function hidePortPopover() {
    if (!portPopover) return;
    clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(hidePortPopoverNow, POPOVER_HIDE_GRACE_MS);
}

function attachPortHover(el, port) {
    el.addEventListener('mouseenter', () => showPortPopover(el, port, titleFor(port)));
    el.addEventListener('mouseleave', hidePortPopover);
}

// A native title= tooltip would show up a second later and duplicate the popover,
// so it is only used while expanded — where it reveals an ellipsised title.
function applyNativeTooltip(el, port) {
    const title = titleFor(port);
    if (title && isSidebarCollapsed()) {
        el.removeAttribute('title');
    } else if (title) {
        el.title = `${title} — localhost:${port}`;
    } else {
        el.title = `localhost:${port}`;
    }
}

// Push tab state up to main so the control server can answer GET /ports
function syncStateToMain() {
    if (!window.devBrowser) return;
    window.devBrowser.syncState({
        openTabs: openTabs,
        selectedPort: selectedPort,
        detectedPorts: activeDetectedPorts
    });
}

// --- 2. Render Functions ---

// Render Range List in Settings editor
function renderConfigEditor() {
    const ranges = loadRanges();
    rangesList.innerHTML = '';
    ranges.forEach((range, idx) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${range}</span>
            <button class="delete-range-btn" data-idx="${idx}">delete</button>
        `;
        rangesList.appendChild(li);
    });

    // Attach deletes
    document.querySelectorAll('.delete-range-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.getAttribute('data-idx'), 10);
            const ranges = loadRanges();
            ranges.splice(idx, 1);
            saveRanges(ranges);
        });
    });
}

// Render the grid of ports based on configured ranges
function renderPortsGrid() {
    const ranges = loadRanges();
    const ports = parseRanges(ranges);
    quickPortsGrid.innerHTML = '';
    
    if (ports.length === 0) {
        quickPortsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); font-size: 12px; padding: 20px;">No ports configured. Click settings to add.</div>';
        return;
    }

    ports.forEach(port => {
        const card = document.createElement('button');
        card.className = 'port-card';
        card.id = `port-card-${port}`;

        const title = titleFor(port);
        const portLabel = document.createElement('span');
        portLabel.className = 'port-num';
        portLabel.innerText = port;
        card.appendChild(portLabel);

        if (title) {
            card.classList.add('has-title');
            const titleLabel = document.createElement('span');
            titleLabel.className = 'port-title';
            titleLabel.innerText = title;
            card.appendChild(titleLabel);
        }
        applyNativeTooltip(card, port);

        // Apply state classes
        if (openTabs.includes(port)) card.classList.add('active-tab');
        if (activeDetectedPorts.includes(port)) card.classList.add('detected-active');

        card.addEventListener('click', () => openPort(port));
        attachPortHover(card, port);
        quickPortsGrid.appendChild(card);
    });
}

// Render detected active ports list at the top of sidebar
function renderDetectedPortsList() {
    if (activeDetectedPorts.length === 0) {
        detectedPortsList.innerHTML = 'Scanning localhost...';
        detectedPortsList.className = 'ports-list empty';
        return;
    }

    detectedPortsList.innerHTML = '';
    detectedPortsList.className = 'ports-list';

    activeDetectedPorts.forEach(port => {
        const strip = document.createElement('div');
        strip.className = 'port-strip';

        // Named ports lead with the title and keep the port as a secondary label
        const title = titleFor(port);
        const label = title
            ? `<span class="strip-label"><span class="strip-title">${escapeHtml(title)}</span><span class="strip-port">Port ${port}</span></span>`
            : `<span class="strip-label"><span class="strip-title untitled">Port ${port}</span></span>`;

        strip.innerHTML = `
            ${label}
            <span class="badge">Active</span>
        `;
        applyNativeTooltip(strip, port);
        strip.addEventListener('click', () => openPort(port));
        attachPortHover(strip, port);
        detectedPortsList.appendChild(strip);
    });
}

// --- 3. WebView & Tab Manager ---

// Build a localhost URL, tolerating a path with or without its leading slash
function urlForPort(port, targetPath) {
    const clean = (targetPath || '').replace(/^\/+/, '');
    return `http://localhost:${port}/${clean}`;
}

function openPort(port, targetPath, shouldSelect = true) {
    if (!openTabs.includes(port)) {
        openTabs.push(port);

        // Instantiate <webview> tag in container
        const webview = document.createElement('webview');
        webview.setAttribute('src', urlForPort(port, targetPath));
        webview.setAttribute('id', `webview-${port}`);
        // Disable web security to allow local host frames and bypass strict CORS issues during development
        webview.setAttribute('webpreferences', 'webSecurity=no, contextIsolation=yes');
        
        // Add navigation listeners
        webview.addEventListener('did-finish-load', () => updateBrowserButtons(port));
        webview.addEventListener('did-navigate', () => updateBrowserButtons(port));
        webview.addEventListener('did-navigate-in-page', () => updateBrowserButtons(port));
        
        webviewContainer.appendChild(webview);
        localStorage.setItem('open-tabs', JSON.stringify(openTabs)); // Save state
    } else if (targetPath !== undefined && targetPath !== null) {
        // Tab already exists, so honour the requested path instead of ignoring it
        const webview = document.getElementById(`webview-${port}`);
        if (webview) webview.loadURL(urlForPort(port, targetPath));
    }

    if (shouldSelect) selectTab(port);
    renderPortsGrid();
    syncStateToMain();
}

// Reflect the active tab's friendly name in the OS window title and address bar
function updateActiveTabLabels() {
    const title = selectedPort === null ? null : titleFor(selectedPort);

    if (selectedPort === null) {
        document.title = 'Dev Browser - Windows Desktop';
    } else {
        document.title = title
            ? `${title} (:${selectedPort}) - Dev Browser`
            : `localhost:${selectedPort} - Dev Browser`;
    }

    if (addressTitle) {
        addressTitle.innerText = title || '';
        addressTitle.classList.toggle('hidden', !title);
    }
}

function selectTab(port) {
    selectedPort = port;
    localStorage.setItem('selected-port', port === null ? '' : port); // Save state

    if (port === null) {
        webHomeBtn.classList.add('active');
        dashboardLanding.classList.remove('hidden');
        browserView.classList.add('hidden');
    } else {
        webHomeBtn.classList.remove('active');
        dashboardLanding.classList.add('hidden');
        browserView.classList.remove('hidden');
        
        // Update webview visibilities
        const webviews = webviewContainer.querySelectorAll('webview');
        webviews.forEach(wv => {
            if (wv.id === `webview-${port}`) {
                wv.classList.add('active');
                updateBrowserButtons(port);
            } else {
                wv.classList.remove('active');
            }
        });
    }

    updateActiveTabLabels();
    syncStateToMain();
}

function closeTab(port) {
    // Remove from open list
    openTabs = openTabs.filter(t => t !== port);
    localStorage.setItem('open-tabs', JSON.stringify(openTabs)); // Save state
    
    // Destroy DOM element
    const webview = document.getElementById(`webview-${port}`);
    if (webview) webview.remove();
    
    // Adjust selection if necessary
    if (selectedPort === port) {
        if (openTabs.length > 0) {
            selectTab(openTabs[openTabs.length - 1]);
        } else {
            selectTab(null);
        }
    }
    renderPortsGrid();
    syncStateToMain();
}

function updateBrowserButtons(port) {
    if (selectedPort !== port) return;
    const webview = document.getElementById(`webview-${port}`);
    if (!webview) return;
    
    try {
        webBackBtn.disabled = !webview.canGoBack();
        webForwardBtn.disabled = !webview.canGoForward();
        
        // Update address text with current webview URL
        const url = webview.getURL();
        if (url) {
            try {
                const parsed = new URL(url);
                addressHost.innerText = `${parsed.host}/`;
                
                // Only update the path input if the user is not actively typing/focusing it
                if (document.activeElement !== addressPathInput) {
                    let path = parsed.pathname.substring(1) + parsed.search + parsed.hash;
                    addressPathInput.value = path;
                }
            } catch (err) {
                addressHost.innerText = `localhost:${port}/`;
                if (document.activeElement !== addressPathInput) {
                    addressPathInput.value = '';
                }
            }
        } else {
            addressHost.innerText = `localhost:${port}/`;
            if (document.activeElement !== addressPathInput) {
                addressPathInput.value = '';
            }
        }
    } catch (e) {
        // Webview API might not be ready yet
    }
}

// --- 4. Resizer & Orientation Actions ---

function handleResizerClick(e) {
    const btn = e.target;
    const type = btn.getAttribute('data-type');
    
    // Toggle active state on buttons for this category
    const groupButtons = btn.closest('.btn-group').querySelectorAll('.resizer-btn');
    groupButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    if (type === 'window') {
        const width = parseInt(btn.getAttribute('data-width'), 10);
        const height = parseInt(btn.getAttribute('data-height'), 10);
        
        // Reset internal viewport back to Fit
        resetInternalViewport();
        
        // Send IPC to resize OS Window
        window.windowManager.resize(width, height);
    } else if (type === 'viewport') {
        const device = btn.getAttribute('data-device');
        
        if (device === 'fit') {
            resetInternalViewport();
        } else {
            const width = parseInt(btn.getAttribute('data-width'), 10);
            const height = parseInt(btn.getAttribute('data-height'), 10);
            setInternalViewport(device, width, height);
        }
    }
}

function setInternalViewport(device, width, height) {
    currentDeviceWidth = width;
    currentDeviceHeight = height;
    
    // Update wrapper classes
    deviceWrapper.className = device;
    if (isLandscape) deviceWrapper.classList.add('landscape');
    
    // Apply exact styling
    updateDeviceDimensions();
    
    // Enable Orientation toggle
    orientationBtn.disabled = false;
    dimensionsBadge.classList.remove('hidden');
    
    // Add device mode padding
    document.getElementById('viewport-canvas').classList.add('device-mode');
}

function resetInternalViewport() {
    deviceWrapper.className = 'fit';
    
    // Apply exact styling
    updateDeviceDimensions();
    
    // Disable orientation
    orientationBtn.disabled = true;
    dimensionsBadge.classList.add('hidden');
    
    // Remove device mode padding
    document.getElementById('viewport-canvas').classList.remove('device-mode');
    
    // Make sure 'Fit' viewport button is active
    document.querySelectorAll('[data-type="viewport"]').forEach(btn => {
        if (btn.getAttribute('data-device') === 'fit') {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function toggleOrientation() {
    if (deviceWrapper.classList.contains('fit')) return;
    
    isLandscape = !isLandscape;
    deviceWrapper.classList.toggle('landscape', isLandscape);
    updateDeviceDimensions();
}

function updateDeviceDimensions() {
    if (deviceWrapper.className === 'fit') {
        deviceWrapper.style.width = '100%';
        deviceWrapper.style.height = '100%';
        deviceWrapper.style.transform = 'none';
        return;
    }
    
    const canvas = document.getElementById('viewport-canvas');
    if (!canvas) return;
    
    const padding = 80; // 40px padding on each side
    const canvasWidth = Math.max(100, canvas.clientWidth - padding);
    const canvasHeight = Math.max(100, canvas.clientHeight - padding);
    
    // Calculate target aspect ratio based on selected device presets
    const baseWidth = isLandscape ? currentDeviceHeight : currentDeviceWidth;
    const baseHeight = isLandscape ? currentDeviceWidth : currentDeviceHeight;
    const ratio = baseWidth / baseHeight;
    
    let targetWidth, targetHeight;
    
    // Fit to available space maintaining aspect ratio
    if (canvasWidth / canvasHeight > ratio) {
        // Canvas is wider than target ratio -> fit to height
        targetHeight = canvasHeight;
        targetWidth = canvasHeight * ratio;
    } else {
        // Canvas is taller than target ratio -> fit to width
        targetWidth = canvasWidth;
        targetHeight = canvasWidth / ratio;
    }
    
    // Set actual pixel dimensions on the wrapper (no CSS scaling blurriness!)
    deviceWrapper.style.width = `${Math.round(targetWidth)}px`;
    deviceWrapper.style.height = `${Math.round(targetHeight)}px`;
    deviceWrapper.style.transform = 'none';
    
    // Update dimensions badge with actual rendered layout pixels
    const w = Math.round(targetWidth);
    const h = Math.round(targetHeight);
    dimensionsBadge.innerText = `${w}px × ${h}px (${isLandscape ? 'Landscape' : 'Portrait'} - Aspect ${baseWidth}:${baseHeight})`;
}

async function checkActivePorts() {
    try {
        const allowedPortsList = parseRanges(loadRanges());
        const activePorts = await window.portManager.getActivePorts(allowedPortsList);
        activeDetectedPorts = activePorts;
        
        renderDetectedPortsList();
        renderPortsGrid();
        syncStateToMain();
    } catch (e) {
        console.error("Failed to query active ports via IPC:", e);
    }
}

// --- 5b. Agent Control Channel ---

// Re-render everything that can show a friendly name
function applyTitles(titles) {
    portTitles = titles || {};
    renderPortsGrid();
    renderDetectedPortsList();
    updateActiveTabLabels();
}

// Commands arrive from the control server via main; they reuse the same tab
// functions the UI buttons do, so behaviour stays identical either way.
function handleRemoteCommand(command) {
    if (!command || typeof command.port !== 'number') return;
    const { action, port, path: targetPath } = command;

    switch (action) {
        case 'open':
            openPort(port, targetPath, command.select !== false);
            break;
        case 'navigate': {
            // Open the tab first if it isn't already there, otherwise there is
            // nothing to navigate.
            if (!openTabs.includes(port)) {
                openPort(port, targetPath, command.select !== false);
                break;
            }
            const webview = document.getElementById(`webview-${port}`);
            if (webview) webview.loadURL(urlForPort(port, targetPath));
            if (command.select !== false) selectTab(port);
            break;
        }
        case 'reload': {
            const webview = document.getElementById(`webview-${port}`);
            if (webview) webview.reload();
            break;
        }
        case 'close':
            if (openTabs.includes(port)) closeTab(port);
            break;
        default:
            console.warn('[dev-browser] unknown remote command:', action);
    }
}

function initControlChannel() {
    if (!window.devBrowser) return;

    window.devBrowser.onTitlesChanged(applyTitles);
    window.devBrowser.onRemoteCommand(handleRemoteCommand);

    window.devBrowser.getTitles()
        .then(applyTitles)
        .catch((e) => console.error('Failed to load port titles:', e));
}

// --- 6. Event Listeners ---

// Configuration Settings Gear Toggle
toggleConfigBtn.addEventListener('click', () => {
    configEditor.classList.toggle('hidden');
});

// Add Port Range
addRangeBtn.addEventListener('click', () => {
    const val = newRangeInput.value.trim();
    if (val) {
        const ranges = loadRanges();
        ranges.push(val);
        saveRanges(ranges);
        newRangeInput.value = '';
    }
});

newRangeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        addRangeBtn.click();
    }
});

// Open Custom Port
openCustomPortBtn.addEventListener('click', () => {
    const port = parseInt(customPortInput.value, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) {
        openPort(port);
        customPortInput.value = '';
    }
});

customPortInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        openCustomPortBtn.click();
    }
});

// Browser Actions
webBackBtn.addEventListener('click', () => {
    if (selectedPort) {
        const webview = document.getElementById(`webview-${selectedPort}`);
        if (webview && webview.canGoBack()) webview.goBack();
    }
});

webForwardBtn.addEventListener('click', () => {
    if (selectedPort) {
        const webview = document.getElementById(`webview-${selectedPort}`);
        if (webview && webview.canGoForward()) webview.goForward();
    }
});

webRefreshBtn.addEventListener('click', () => {
    if (selectedPort) {
        const webview = document.getElementById(`webview-${selectedPort}`);
        if (webview) webview.reload();
    }
});

// Dashboard Home Tab click
webHomeBtn.addEventListener('click', () => selectTab(null));

// Address path input Enter key navigation
addressPathInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        if (selectedPort) {
            const webview = document.getElementById(`webview-${selectedPort}`);
            if (webview) {
                let path = addressPathInput.value.trim();
                // Strip leading slash if any since prefix host has trailing slash
                if (path.startsWith('/')) {
                    path = path.substring(1);
                }
                webview.loadURL(`http://localhost:${selectedPort}/${path}`);
                addressPathInput.blur(); // Remove focus after pressing Enter
            }
        }
    }
});

// Resizer Button events
resizerButtons.forEach(btn => {
    btn.addEventListener('click', handleResizerClick);
});

// Orientation Toggle
orientationBtn.addEventListener('click', toggleOrientation);

// --- 7. Application Startup Bootstrapping ---
window.addEventListener('DOMContentLoaded', () => {
    renderConfigEditor();
    renderPortsGrid();

    // Hydrate agent-assigned titles and start listening for remote commands
    initControlChannel();

    // Restore sidebar state from preferences
    const isSidebarCollapsed = localStorage.getItem('sidebar-collapsed') === 'true';
    if (isSidebarCollapsed) {
        controlPanel.classList.add('collapsed');
        const collapseIcon = document.getElementById('collapse-icon');
        collapseIcon.innerHTML = '<path fill="currentColor" d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/>';
    }
    
    // Run initial active port query
    checkActivePorts();
    
    // Set 15 seconds recurring timer to check active localhost ports
    setInterval(checkActivePorts, 15000);
    
    // Window Resize listener to update scaling
    window.addEventListener('resize', updateDeviceDimensions);

    // The popover is fixed-position, so dismiss it outright whenever its anchor
    // can move out from under it — no grace period in those cases
    const scrollableControls = document.querySelector('.scrollable-controls');
    if (scrollableControls) scrollableControls.addEventListener('scroll', hidePortPopoverNow);
    window.addEventListener('resize', hidePortPopoverNow);
    
    // Collapsible Sidebar Toggle Click Listener
    collapseSidebarBtn.addEventListener('click', () => {
        controlPanel.classList.toggle('collapsed');
        
        // Save sidebar collapsed state to preferences
        localStorage.setItem('sidebar-collapsed', controlPanel.classList.contains('collapsed'));
        
        // Change icon direction path (Arrow Right when collapsed, Arrow Left when expanded)
        const collapseIcon = document.getElementById('collapse-icon');
        if (controlPanel.classList.contains('collapsed')) {
            collapseIcon.innerHTML = '<path fill="currentColor" d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/>';
        } else {
            collapseIcon.innerHTML = '<path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>';
        }

        // Whether a native title= is used depends on the collapsed state, so
        // re-render to refresh it, and drop any popover left showing
        hidePortPopoverNow();
        renderPortsGrid();
        renderDetectedPortsList();


        // Recalculate layout dimensions at key points during CSS transition
        updateDeviceDimensions();
        setTimeout(updateDeviceDimensions, 150);
        setTimeout(updateDeviceDimensions, 300);
    });
});
