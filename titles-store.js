// Persistent store for the friendly names agents assign to dev-server ports.
//
// The file lives in userData so it is reachable from WSL through /mnt/c, which is
// what lets the `devbrowser` CLI record a title while DevBrowser is closed. The app
// loads that file on the next launch, so a title is never silently lost.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_TITLE_LENGTH = 64;
const WATCH_DEBOUNCE_MS = 150;

// Ports arrive from HTTP bodies and JSON files, so everything is untrusted.
function normalizePort(value) {
    const port = typeof value === 'number' ? value : parseInt(String(value == null ? '' : value).trim(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return port;
}

// Collapse whitespace and cap the length: a runaway string would otherwise wreck
// the fixed-width sidebar layout.
function normalizeTitle(value) {
    if (value === null || value === undefined) return null;
    const title = String(value).replace(/\s+/g, ' ').trim();
    if (!title) return null;
    return title.slice(0, MAX_TITLE_LENGTH);
}

class TitlesStore extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.titles = {};
        this._watcher = null;
        this._debounceTimer = null;
    }

    // Never let a missing or hand-mangled file stop the app from starting.
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            this.titles = this._parse(raw);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('[titles-store] could not read titles.json, starting empty:', err.message);
            }
            this.titles = {};
        }
        return this.getAll();
    }

    _parse(raw) {
        const parsed = JSON.parse(raw);
        const source = parsed && typeof parsed.titles === 'object' && parsed.titles !== null ? parsed.titles : {};
        const titles = {};
        for (const [key, value] of Object.entries(source)) {
            const port = normalizePort(key);
            const title = normalizeTitle(value);
            if (port !== null && title !== null) titles[String(port)] = title;
        }
        return titles;
    }

    getAll() {
        return Object.assign({}, this.titles);
    }

    get(port) {
        const normalized = normalizePort(port);
        return normalized === null ? null : (this.titles[String(normalized)] || null);
    }

    set(port, title) {
        const normalized = normalizePort(port);
        if (normalized === null) return { ok: false, error: 'port must be an integer between 1 and 65535' };

        const clean = normalizeTitle(title);
        if (clean === null) return this.clear(normalized);

        if (this.titles[String(normalized)] === clean) return { ok: true, port: normalized, title: clean };
        this.titles[String(normalized)] = clean;
        this._persist();
        return { ok: true, port: normalized, title: clean };
    }

    clear(port) {
        const normalized = normalizePort(port);
        if (normalized === null) return { ok: false, error: 'port must be an integer between 1 and 65535' };

        if (!(String(normalized) in this.titles)) return { ok: true, port: normalized, title: null };
        delete this.titles[String(normalized)];
        this._persist();
        return { ok: true, port: normalized, title: null };
    }

    // Bulk update. A null/empty value clears that port.
    setMany(map) {
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            return { ok: false, error: 'body must be an object mapping port to title' };
        }

        let changed = false;
        for (const [key, value] of Object.entries(map)) {
            const port = normalizePort(key);
            if (port === null) return { ok: false, error: `invalid port: ${key}` };

            const title = normalizeTitle(value);
            const existing = this.titles[String(port)];
            if (title === null) {
                if (String(port) in this.titles) { delete this.titles[String(port)]; changed = true; }
            } else if (existing !== title) {
                this.titles[String(port)] = title;
                changed = true;
            }
        }

        if (changed) this._persist();
        return { ok: true, titles: this.getAll() };
    }

    _serialize() {
        // Sort numerically so the on-disk file stays readable and diff-friendly.
        const ordered = {};
        for (const key of Object.keys(this.titles).sort((a, b) => Number(a) - Number(b))) {
            ordered[key] = this.titles[key];
        }
        return JSON.stringify({ version: SCHEMA_VERSION, titles: ordered }, null, 2) + '\n';
    }

    // Write to a temp file and rename over the target, so the CLI can never observe
    // a half-written file. renameSync replaces the destination on Windows.
    _persist() {
        const payload = this._serialize();
        const tmpPath = `${this.filePath}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(tmpPath, payload, 'utf8');
            fs.renameSync(tmpPath, this.filePath);
        } catch (err) {
            console.error('[titles-store] failed to write titles.json:', err.message);
            try { fs.unlinkSync(tmpPath); } catch (_) { /* nothing to clean up */ }
            return;
        }
        this.emit('changed', this.getAll());
    }

    // Watch the containing directory rather than the file itself: an atomic rename
    // replaces the inode, which detaches a file-level watcher on Windows.
    startWatching() {
        if (this._watcher) return;

        const dir = path.dirname(this.filePath);
        const target = path.basename(this.filePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
            this._watcher = fs.watch(dir, (_eventType, filename) => {
                if (filename && filename !== target) return;
                clearTimeout(this._debounceTimer);
                this._debounceTimer = setTimeout(() => this._reloadIfChanged(), WATCH_DEBOUNCE_MS);
            });
        } catch (err) {
            console.error('[titles-store] watch unavailable, external edits need a restart:', err.message);
        }
    }

    // Only emit when the content actually differs, otherwise our own writes would
    // bounce back through the watcher and loop.
    _reloadIfChanged() {
        const before = this._serialize();
        try {
            this.titles = this._parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') this.titles = {};
            else return;
        }
        if (this._serialize() !== before) this.emit('changed', this.getAll());
    }

    stopWatching() {
        clearTimeout(this._debounceTimer);
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
    }
}

module.exports = { TitlesStore, normalizePort, normalizeTitle, MAX_TITLE_LENGTH };
