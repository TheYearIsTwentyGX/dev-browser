// Loopback HTTP control channel that lets agents drive DevBrowser.
//
// WSL2 runs with networkingMode=mirrored on this machine, so a server bound to the
// Windows 127.0.0.1 is directly reachable from inside the Linux distro. That means
// no firewall rule, no port proxy and no netsh forwarding.
//
// Security note: webviews are created with webSecurity=no, so a dev page loaded in a
// tab could otherwise script this server. Two cheap guards close that off:
//   * any request carrying an Origin header is rejected (browsers always set it
//     cross-origin, curl never does);
//   * a custom X-DevBrowser-Client header is required, which forces a CORS preflight
//     that this server never approves.

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 45777;
const CLIENT_HEADER = 'x-devbrowser-client';
const MAX_BODY_BYTES = 64 * 1024;
const TITLE_ROUTE = /^\/titles\/(\d{1,5})$/;

function isValidPort(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function coercePort(value) {
    const port = typeof value === 'number' ? value : parseInt(String(value == null ? '' : value).trim(), 10);
    return isValidPort(port) ? port : null;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) return resolve({});
            try {
                const parsed = JSON.parse(raw);
                if (parsed === null || typeof parsed !== 'object') {
                    return reject(Object.assign(new Error('body must be a JSON object'), { statusCode: 400 }));
                }
                resolve(parsed);
            } catch (_) {
                reject(Object.assign(new Error('body must be valid JSON'), { statusCode: 400 }));
            }
        });
        req.on('error', reject);
    });
}

class ControlServer {
    /**
     * @param {object} options
     * @param {number} options.port            preferred port; falls back to ephemeral
     * @param {string} options.discoveryPath   where to advertise the live port
     * @param {string} options.version         app version, reported by /health
     * @param {object} options.handlers        wiring into the store and renderer
     */
    constructor({ port = DEFAULT_PORT, discoveryPath, version, handlers }) {
        this.preferredPort = port;
        this.discoveryPath = discoveryPath;
        this.version = version;
        this.handlers = handlers;
        this.server = null;
        this.port = null;
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this._handle(req, res));

            let usedFallback = false;
            this.server.on('error', (err) => {
                // A stale or duplicate instance must never stop the app from starting.
                if (err.code === 'EADDRINUSE' && !usedFallback) {
                    usedFallback = true;
                    console.warn(`[control-server] port ${this.preferredPort} busy, falling back to an ephemeral port`);
                    this.server.listen(0, '127.0.0.1');
                    return;
                }
                console.error('[control-server] failed to start:', err.message);
                reject(err);
            });

            this.server.on('listening', () => {
                this.port = this.server.address().port;
                this._writeDiscoveryFile();
                console.log(`[control-server] listening on http://127.0.0.1:${this.port}`);
                resolve(this.port);
            });

            this.server.listen(this.preferredPort, '127.0.0.1');
        });
    }

    stop() {
        this._removeDiscoveryFile();
        return new Promise((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
            this.server = null;
        });
    }

    // The CLI tries the default port first and reads this only if that fails, so an
    // ephemeral fallback stays discoverable.
    _writeDiscoveryFile() {
        const payload = {
            port: this.port,
            pid: process.pid,
            version: this.version,
            startedAt: new Date().toISOString()
        };
        try {
            fs.mkdirSync(path.dirname(this.discoveryPath), { recursive: true });
            fs.writeFileSync(this.discoveryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        } catch (err) {
            console.error('[control-server] could not write discovery file:', err.message);
        }
    }

    _removeDiscoveryFile() {
        try {
            fs.unlinkSync(this.discoveryPath);
        } catch (_) {
            /* already gone */
        }
    }

    async _handle(req, res) {
        // Reject browser-originated calls before doing any work.
        if (req.headers.origin) {
            return this._send(res, 403, { ok: false, error: 'cross-origin requests are not permitted' });
        }
        if (req.headers[CLIENT_HEADER] !== '1') {
            return this._send(res, 403, { ok: false, error: 'missing X-DevBrowser-Client header' });
        }

        let pathname;
        try {
            pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
        } catch (_) {
            return this._send(res, 400, { ok: false, error: 'malformed request url' });
        }

        try {
            await this._route(req, res, pathname);
        } catch (err) {
            this._send(res, err.statusCode || 500, { ok: false, error: err.message });
        }
    }

    async _route(req, res, pathname) {
        const method = req.method;

        if (method === 'GET' && pathname === '/health') {
            return this._send(res, 200, { ok: true, app: 'dev-browser', version: this.version, port: this.port });
        }

        if (pathname === '/titles') {
            if (method === 'GET') return this._send(res, 200, { ok: true, titles: this.handlers.getTitles() });
            if (method === 'POST') {
                const body = await readBody(req);
                const map = body && typeof body.titles === 'object' && body.titles !== null ? body.titles : body;
                const result = this.handlers.setTitles(map);
                return this._send(res, result.ok ? 200 : 400, result);
            }
            return this._methodNotAllowed(res, 'GET, POST');
        }

        const titleMatch = TITLE_ROUTE.exec(pathname);
        if (titleMatch) {
            const port = coercePort(titleMatch[1]);
            if (port === null) {
                return this._send(res, 400, { ok: false, error: 'port must be an integer between 1 and 65535' });
            }
            if (method === 'PUT') {
                const body = await readBody(req);
                const result = this.handlers.setTitle(port, body.title);
                return this._send(res, result.ok ? 200 : 400, result);
            }
            if (method === 'DELETE') {
                const result = this.handlers.clearTitle(port);
                return this._send(res, result.ok ? 200 : 400, result);
            }
            if (method === 'GET') {
                return this._send(res, 200, { ok: true, port, title: this.handlers.getTitles()[String(port)] || null });
            }
            return this._methodNotAllowed(res, 'GET, PUT, DELETE');
        }

        if (pathname === '/ports') {
            if (method !== 'GET') return this._methodNotAllowed(res, 'GET');
            return this._send(res, 200, Object.assign({ ok: true }, this.handlers.getPorts()));
        }

        if (pathname.startsWith('/tabs/')) {
            if (method !== 'POST') return this._methodNotAllowed(res, 'POST');

            const action = pathname.slice('/tabs/'.length);
            if (!['open', 'navigate', 'reload', 'close'].includes(action)) {
                return this._send(res, 404, { ok: false, error: `unknown tab action: ${action}` });
            }

            const body = await readBody(req);
            const port = coercePort(body.port);
            if (port === null) {
                return this._send(res, 400, { ok: false, error: 'port must be an integer between 1 and 65535' });
            }
            if (action === 'navigate' && (body.path === undefined || body.path === null)) {
                return this._send(res, 400, { ok: false, error: 'navigate requires a path' });
            }

            const result = this.handlers.sendCommand({
                action,
                port,
                path: typeof body.path === 'string' ? body.path : undefined,
                select: body.select !== false
            });
            return this._send(res, result.ok ? 200 : 503, result);
        }

        return this._send(res, 404, { ok: false, error: `unknown endpoint: ${pathname}` });
    }

    _methodNotAllowed(res, allow) {
        res.setHeader('Allow', allow);
        return this._send(res, 405, { ok: false, error: `method not allowed, expected one of: ${allow}` });
    }

    _send(res, statusCode, payload) {
        const body = JSON.stringify(payload) + '\n';
        res.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
        });
        res.end(body);
    }
}

module.exports = { ControlServer, DEFAULT_PORT, CLIENT_HEADER };
