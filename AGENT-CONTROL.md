# Agent control channel

DevBrowser runs a small HTTP control server so tools outside the app — in practice,
coding agents working inside WSL2 — can give each dev-server port a friendly name and
drive tabs. Without it every tab is an anonymous port number.

## Why this works

The Electron main process binds a server to the **Windows** `127.0.0.1:45777`. This
machine runs WSL with `networkingMode=mirrored`, so that loopback address is reachable
straight from the Linux distro. No firewall rule, no `netsh portproxy`, no forwarding.

If 45777 is already taken the server falls back to an ephemeral port and advertises the
real one in `control-server.json` (see below).

## The CLI

The canonical script is `cli/devbrowser` in this repo. Install it into WSL with:

```bash
cp cli/devbrowser ~/.local/bin/devbrowser && chmod +x ~/.local/bin/devbrowser
```

It needs only `bash`, `curl`, `python3` and `wslpath` — deliberately no npm dependency,
since node is nvm-managed here and not on `PATH` in every shell.

```
devbrowser title <port> "<name>"    assign a friendly name to a port
devbrowser title <port> --clear     remove the name
devbrowser titles [--json]          list all assigned names
devbrowser open <port> [path]       open (or focus) a tab
devbrowser go <port> <path>         navigate an existing tab
devbrowser reload <port>            reload a tab
devbrowser close <port>             close a tab
devbrowser ports [--json]           detected / open / selected ports
devbrowser status                   is the app reachable, and on which port
```

Exit codes: `0` success, `1` usage or validation error, `2` DevBrowser not running.

### Titles work even when DevBrowser is closed

`devbrowser title` falls back to writing `titles.json` directly under `%APPDATA%`, which
the app loads at startup and also watches while running. So an agent can label a port at
dev-server startup regardless of whether the browser is open. Tab commands (`open`, `go`,
`reload`, `close`) need a live window and exit `2` when there isn't one.

## Files

Both live in the Electron `userData` directory — on Windows
`%APPDATA%\dev-browser-desktop\`, reachable from WSL as
`/mnt/c/Users/<you>/AppData/Roaming/dev-browser-desktop/`.

| File | Purpose |
|---|---|
| `titles.json` | `{"version":1,"titles":{"5001":"LTCDataPlus web"}}` — the source of truth |
| `control-server.json` | `{port,pid,version,startedAt}` — how the CLI finds a non-default port |

A stale `control-server.json` (left behind by a crash) is harmless: the CLI probes the
advertised port and ignores it if nothing answers.

## HTTP API

Every request must send `X-DevBrowser-Client: 1` and must **not** carry an `Origin`
header. Webviews run with `webSecurity=no`, so without those two guards a page loaded in
a tab could script the app: browsers always attach `Origin` cross-origin, and the custom
header forces a CORS preflight that the server never approves. `curl` satisfies both
naturally.

| Method | Path | Body / result |
|---|---|---|
| `GET` | `/health` | `{ok, app, version, port}` |
| `GET` | `/titles` | `{ok, titles}` |
| `POST` | `/titles` | bulk map of port → title; `null` clears |
| `GET` | `/titles/:port` | `{ok, port, title}` |
| `PUT` | `/titles/:port` | `{title}` |
| `DELETE` | `/titles/:port` | clear one |
| `GET` | `/ports` | `{ok, detected, open, selected, titles}` |
| `POST` | `/tabs/open` | `{port, path?, select?}` |
| `POST` | `/tabs/navigate` | `{port, path}` |
| `POST` | `/tabs/reload` | `{port}` |
| `POST` | `/tabs/close` | `{port}` |

Ports must be integers in 1–65535. Titles are whitespace-collapsed and capped at 64
characters so they cannot break the sidebar layout; responses report the stored value.

Calling it directly:

```bash
curl -s -H 'X-DevBrowser-Client: 1' http://127.0.0.1:45777/titles

curl -s -X PUT -H 'X-DevBrowser-Client: 1' -H 'Content-Type: application/json' \
     -d '{"title":"LTCDataPlus web"}' http://127.0.0.1:45777/titles/5001
```

## Where it lives in the code

| File | Role |
|---|---|
| `titles-store.js` | Loads/persists `titles.json`, atomic tmp+rename writes, watches the directory for external edits |
| `control-server.js` | HTTP routing, request guards, discovery file |
| `main.js` | Wires the two together, relays commands and title changes to the renderer, caches renderer tab state for `GET /ports` |
| `preload.js` | Exposes `window.devBrowser` to the renderer |
| `renderer.js` | Renders titles in the port grid, detected list, address bar and window title; executes remote commands |

Titles are displayed in four places: the Quick Select cards, the Detected Active Ports
strips, a chip in the address bar, and the OS window title.
