# Nearby — Team Presence Widget

A floating always-on-top desktop widget that shows your whole team's online/offline status and who is working with whom — no cloud accounts, no servers to deploy.

Anyone on the team can start the relay. Anyone else installs the same app and joins via an invite link. If the relay owner closes the app, the remaining members race to take it over automatically — the team stays online within ≈7 seconds.

---

## How it works

### Relay model

Every member runs the same app. On startup each member races to acquire a **deterministic WebSocket tunnel subdomain** derived from the team's channel ID. The first to win becomes the **relay** (role: `host`) and serves the channel. Everyone else connects as a **guest**.

|                   | Relay owner (host)                                                          | Guest                             |
| ----------------- | --------------------------------------------------------------------------- | --------------------------------- |
| **Runs server?**  | Yes — embedded WebSocket server on port `4993`                              | No                                |
| **Public tunnel** | Yes — localtunnel opens a `wss://` URL so guests connect over the internet  | No                                |
| **Role**          | Dynamic — whoever wins the subdomain race on startup                        | Everyone else                     |
| **Setup**         | Creates team, enters name + team name                                       | Pastes invite link                |
| **Data on disk**  | `state.json` in app user data                                               | `state.json` in app user data     |
| **Server data**   | In-memory only, wiped on app close                                          | N/A                               |

### Invite link format

```
nearby://join/{base64url(JSON.stringify({ ws, channelId }))}
```

`ws` is the deterministic `wss://` tunnel URL. `channelId` is the team's UUID. Any member can generate and share this link — it is not restricted to the current relay owner.

Example: `nearby://join/eyJ3cyI6Indzcz...`

The tunnel subdomain is derived **deterministically** from the `channelId`:

```
subdomain = 'nearby-' + channelId.replace(/-/g, '').slice(0, 12)
```

Because the subdomain is stable, the invite link is permanently valid — no need to reshare after a relay handoff.

### Network access check

On every launch, before any window opens, the app verifies network connectivity via `electronNet.isOnline()`. On macOS it also opens a socket to `loca.lt` so the OS fires the network-permission dialog early. If the device is offline, a blocking error is shown and the app quits.

### What happens when the relay owner goes offline

- The embedded WS server stops.
- All guests lose their connection immediately.
- Each guest races to acquire the tunnel subdomain on the first disconnect. The first to win becomes the new relay.
- Losers get "subdomain not honored" immediately (loca.lt signals the subdomain is taken) and reconnect to the new relay.
- **Total offline time: ≈7 seconds** for losing guests.
- If loca.lt is slow to release the subdomain, each guest retries every ≈7 s until one wins.
- All peer data is preserved locally in `state.json`.

---

## Widget layout

The widget is **172 px wide** and auto-sizes its height to content.

**Pair cards** — when two users have an active relationship (`working_with` or `waiting_for`), they appear **side-by-side** in a tinted card with a connecting line and a label below:

```
┌─────────────────────────┐
│  ○──────────○           │  ← green tint = working with
│  Hady     Sara          │
│       working           │
└─────────────────────────┘
```

Amber tint = waiting for.

**Solo peers** — users with no active relationship appear as individual circles below a divider.

**Self circle** — shown solo when you have no active relationship; moves into a pair card when you do.

### Setting a relationship

Click any peer circle to open an inline popover:

- **Working with** — green pair card
- **Waiting for** — amber pair card
- **Clear** — removes the relationship

Relationships are synced to all peers immediately and persisted to `state.json`.

### Reconnect banner

When the relay is unreachable (shown after the 2nd consecutive connection failure), a banner appears:

> "Team relay offline. Auto-reconnecting… or paste an invite link to retry."

The banner lets any member paste a fresh invite link to force a reconnect. The relay takeover loop runs in parallel — if another member wins the subdomain first, the app reconnects automatically without any action needed.

---

## Background sync

Every 5 seconds each client broadcasts a `SYNC_CHECK` message containing its `dataVersion` (the highest `updatedAt` timestamp across all local records). If a peer has a newer version, the lagging client sends `REQUEST_SYNC`; the target replies with a full `STATE_RESPONSE` containing peers and relationships. This keeps all clients converged even if a message was missed.

---

## Tray menu

Right-click the tray icon:

| Item | Shown when | What it does |
| ---- | ---------- | ------------ |
| **Copy invite link** | Any member with a `channelId` | Copies the deterministic `nearby://join/…` link to clipboard |
| **Reset team…** | Role is `host` (relay owner) | Confirmation dialog → sends `RESET` → all members return to setup |
| **Leave team** | Role is `guest` | Same as Reset but for guests |
| **Open DevTools** | Always | Detached DevTools for the active window |
| **View log file** | Always | Opens `nearby.log` in the default text editor |
| **Close Nearby** | Always | `app.quit()` |

---

## App menu bar

A native OS menu bar is shown above the window (always visible on macOS; visible on focus on Windows/Linux).

| Menu | Items |
| ---- | ----- |
| **File** | Close (macOS) / Quit (Windows/Linux) |
| **Edit** | Undo, Redo, Cut, Copy, Paste, Select All |
| **View** | Reload, Toggle DevTools, Actual Size, Zoom In/Out, Toggle Fullscreen |
| **Window** | Minimize, Zoom (macOS), Bring All to Front (macOS) |
| **Help** | **View Log** — opens `nearby.log` in the default text editor |

---

## Dev mode

**Prerequisites:** Node.js 20+, npm 9+

```bash
npm install
npm run dev
```

Starts Vite on `http://localhost:3000` (React hot reload) and Electron pointing at it. DevTools open automatically.

> **Before rebuilding:** close the running Nearby app first (tray → Close Nearby), otherwise electron-builder can't overwrite the DLLs in `release\win-unpacked`.

---

## Building the installer

```bash
npm run dist:win    # Windows (.exe NSIS installer)
npm run dist:mac    # macOS (.dmg)  — must run on macOS
npm run dist:linux  # Linux (.AppImage)
```

Output lands in `./release/`.

For a signed and published release use `build.mjs` directly (see **Releasing** below).

### Icons

Place files in `src/assets/` before building:

- `src/assets/Nearby.ico` — Windows
- `src/assets/Nearby.icns` — macOS
- `src/assets/Nearby.png` — Linux (512×512)

---

## Releasing

Releases are built, signed, and published by `build.mjs`.

### Windows

Runs on any OS. Signing is handled by SignPath via GitHub Actions — push a `v*` tag to trigger it.

### macOS (must run on a Mac)

Requires an [Apple Developer account](https://developer.apple.com) and a **Developer ID Application** certificate in your Keychain.

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="XXXXXXXXXX"                           # developer.apple.com → Membership
export GH_TOKEN="ghp_..."

node build.mjs --mac --publish
```

This builds the DMG, signs it with your Developer ID certificate, submits it to Apple for notarization, staples the ticket, and uploads to GitHub Releases. Users see no Gatekeeper warning.

### Via GitHub Actions (both platforms)

Push a version tag — both jobs run in parallel:

```bash
# bump version in package.json first, then:
git add package.json
git commit -m "chore: bump to vX.Y.Z"
git tag vX.Y.Z
git push origin master --tags
```

Both jobs use the built-in `github.token` for publishing — no `GH_TOKEN` secret needed.

Required GitHub secrets:

| Secret | Used by |
| ------ | ------- |
| `APPLE_CERTIFICATE` | macOS — Developer ID cert (base64 p12) |
| `APPLE_CERTIFICATE_PASSWORD` | macOS — p12 password |
| `APPLE_ID` | macOS — notarization Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS — notarization app-specific password |
| `APPLE_TEAM_ID` | macOS — 10-character team ID |
| `SIGNPATH_API_TOKEN` | Windows — SignPath API token for Authenticode signing |

Windows signing is handled by [SignPath](https://signpath.io) (free for open source). The signed installer and `latest.yml` (for auto-update) are published directly to the GitHub Release.

---

## Project structure

```
electron.js      ← main process: IPC, window management, tray, tunnel, deep link
server.js        ← embedded WebSocket server (relay owner only, in-memory)
preload.js       ← contextBridge — exposes electronAPI to the renderer
logger.js        ← shared file logger (main + renderer write to nearby.log)
vite.config.js   ← bundles src/ → dist/ for production
src/
  main.jsx               ← React entry point
  index.html             ← HTML shell (CSP allows ws: wss:)
  App.jsx                ← root component, hydrates state, races for relay on startup
  views/
    SetupView.jsx        ← first-launch: create or join a team
    WidgetView.jsx       ← floating widget: pair cards + solo peers
  components/
    PeerCircle.jsx       ← single user avatar with online ring
  hooks/
    useWebSocket.js      ← WS lifecycle, reconnect, relay takeover, message dispatch, sync timer
  store/
    state.js             ← lightweight pub/sub store (getState / setState / subscribe)
  styles/
    app.css              ← all styles (light + dark via prefers-color-scheme)
```

---

## Message protocol

All messages are JSON over WebSocket.

| Message               | Direction                    | Purpose                                                                  |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `HELLO`               | Client → Server              | Register on channel; triggers color assignment and PEER_JOINED broadcast |
| `COLOR_ASSIGN`        | Server → Client              | Assign a unique color to the new peer                                    |
| `PEER_JOINED`         | Server → All others          | Notify existing peers of the newcomer                                    |
| `STATE_RESPONSE`      | Client → Server → target     | Full peer + relationship state sent to a specific peer                   |
| `PING`                | Client → Server → All others | Heartbeat for presence detection (every 5 s)                             |
| `UPDATE`              | Client → Server → All others | Name change                                                              |
| `PAIR`                | Client → Server → All others | Pair/unpair with another peer (legacy field)                             |
| `PEER_OFFLINE`        | Server → All                 | Notify when a WS connection drops                                        |
| `RESET`               | Client → Server → All        | Host wipes channel; everyone returns to setup                            |
| `SYNC_CHECK`          | Client → Server → All others | Broadcast local `dataVersion`; lagging peers request sync                |
| `REQUEST_SYNC`        | Client → Server → target     | Ask a specific peer to send their full state                             |
| `RELATIONSHIP_UPDATE` | Client → Server → All others | Create/update/clear a relationship between two peers                     |

Every message must include a top-level `userId` field (the sender's ID). Messages missing `type`, `channelId`, or `userId` are silently dropped by the server.

### Relationship object

```json
{
  "id": "userId1-userId2", // sorted user IDs joined with '-'
  "userA": "...",
  "userB": "...",
  "state": "working_with", // "working_with" | "waiting_for" | null
  "updatedAt": 1718000000000,
  "updatedBy": "..."
}
```

Conflict resolution is last-write-wins on `updatedAt` (`>=` comparison).

---

## Data storage

Each machine stores `state.json` in the OS app data directory:

- **Windows**: `%APPDATA%\Nearby\state.json`
- **macOS**: `~/Library/Application Support/Nearby/state.json`
- **Linux**: `~/.config/Nearby/state.json`

Schema:

```json
{
  "self":  { "userId", "name", "color", "channelId", "teamName", "role", "port", "wsUrl", "pairedWith" },
  "peers": [ { "userId", "name", "color", "updatedAt", "pairedWith", "online", "lastSeen" } ],
  "relationships": [ { "id", "userA", "userB", "state", "updatedAt", "updatedBy" } ]
}
```

`role` is `"host"` when this member currently holds the relay subdomain and `"guest"` otherwise. It is written dynamically on every startup based on who wins the subdomain race — it does not permanently assign the relay to the original creator.

The server holds **no data on disk**. All state is in-memory and resets when the relay app closes.

---

## Log file

Nearby writes a log to the same app data directory: `nearby.log`. Open it from the tray → **View log file** or Help → **View Log**.

Format: `[ISO timestamp] [context] message`

Contexts: `main` (app startup, server/tunnel events), `server` (WS connections, message routing), `ws` (renderer-side WebSocket lifecycle), `bypass` (loca.lt bypass header injection).
