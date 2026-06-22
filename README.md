# Nearby — Team Presence Widget

A floating always-on-top desktop widget that shows your whole team's online/offline status and who is working with whom — no cloud accounts, no servers to deploy.

One person runs as **Host**. Everyone else installs the same app and joins via an invite link.

---

## How it works

### Host / Guest model

|                   | Host                                                                       | Guest                         |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------- |
| **Runs server?**  | Yes — embedded WebSocket server on port `4993`                             | No                            |
| **Public tunnel** | Yes — localtunnel opens a `wss://` URL so guests connect over the internet | No                            |
| **Setup**         | Creates team, enters name + team name                                      | Pastes invite link            |
| **Data on disk**  | `state.json` in app user data                                              | `state.json` in app user data |
| **Server data**   | In-memory only, wiped on app close                                         | N/A                           |

### Invite link format

```
nearby://join/{base64url(JSON.stringify({ ws, channelId }))}
```

`ws` is the public `wss://` tunnel URL (or LAN fallback). `channelId` is the team's UUID.

Example: `nearby://join/eyJ3cyI6Indzcz...`

The tunnel subdomain is derived **deterministically** from the `channelId`:

```
subdomain = 'nearby-' + channelId.replace(/-/g, '').slice(0, 12)
```

This means the host's tunnel URL is **stable across restarts** — guests can reconnect without a new invite link.

### Network access check

On every launch, before any window opens, the app verifies network connectivity via `electronNet.isOnline()`. On macOS it also opens a socket to `loca.lt` so the OS fires the network-permission dialog early. If the device is offline, a blocking error is shown and the app quits.

### What happens when the host goes offline

- The embedded WS server stops.
- Guests lose their connection immediately.
- Each guest's app retries every 5 seconds, showing a pulsing ring on their avatar while disconnected.
- All peer data is preserved locally in `state.json`.
- When the host restarts, the server comes back on the same tunnel subdomain and guests reconnect automatically.

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

---

## Background sync

Every 5 seconds each client broadcasts a `SYNC_CHECK` message containing its `dataVersion` (the highest `updatedAt` timestamp across all local records). If a peer has a newer version, the lagging client sends `REQUEST_SYNC`; the target replies with a full `STATE_RESPONSE` containing peers and relationships. This keeps all clients converged even if a message was missed.

---

## Dev mode

**Prerequisites:** Node.js 18+, npm 9+

```bash
npm install
npm run dev
```

Starts Vite on `http://localhost:3000` (React hot reload) and Electron pointing at it. DevTools open automatically.

---

## Building the installer

```bash
npm run dist        # current platform
npm run dist:win    # Windows (.exe NSIS installer)
npm run dist:mac    # macOS (.dmg)  — must run on macOS
npm run dist:linux  # Linux (.AppImage)
```

Output lands in `./release/`.

### Icons (optional)

Place files in `./assets/` before building:

- `assets/icon.ico` — Windows (256×256)
- `assets/icon.icns` — macOS
- `assets/icon.png` — Linux (512×512)

---

## Project structure

```
electron.js      ← main process: IPC, window management, tray, tunnel, deep link
server.js        ← embedded WebSocket server (host only, in-memory)
preload.js       ← contextBridge — exposes electronAPI to the renderer
logger.js        ← shared file logger (main + renderer write to nearby.log)
vite.config.js   ← bundles src/ → dist/ for production
src/
  App.jsx                ← root component, hydrates state, routes between views
  views/
    SetupView.jsx        ← first-launch: create or join a team
    WidgetView.jsx       ← floating widget: pair cards + solo peers
  components/
    PeerCircle.jsx       ← single user avatar with online ring
  hooks/
    useWebSocket.js      ← WS lifecycle, reconnect, message dispatch, sync timer
  store/
    state.js             ← lightweight pub/sub store (getState / setState / subscribe)
  styles/
    app.css              ← all styles (light + dark via prefers-color-scheme)
```

---

## Message protocol

All messages are JSON over WebSocket.

| Message               | Direction                | Purpose                                                                  |
| --------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `HELLO`               | Client → Server          | Register on channel; triggers color assignment and PEER_JOINED broadcast |
| `COLOR_ASSIGN`        | Server → Client          | Assign a unique color to the new peer                                    |
| `PEER_JOINED`         | Server → All others      | Notify existing peers of the newcomer                                    |
| `STATE_RESPONSE`      | Client → Server → target | Full peer + relationship state sent to a specific peer                   |
| `PING`                | Client → Server → All    | Heartbeat for presence detection (every 5 s)                             |
| `UPDATE`              | Client → Server → All    | Name change                                                              |
| `PAIR`                | Client → Server → All    | Pair/unpair with another peer (legacy field)                             |
| `PEER_OFFLINE`        | Server → All             | Notify when a WS connection drops                                        |
| `RESET`               | Client → Server → All    | Host wipes channel; everyone returns to setup                            |
| `SYNC_CHECK`          | Client → Server → All    | Broadcast local `dataVersion`; lagging peers request sync                |
| `REQUEST_SYNC`        | Client → Server → target | Ask a specific peer to send their full state                             |
| `RELATIONSHIP_UPDATE` | Client → Server → All    | Create/update/clear a relationship between two peers                     |

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

The server holds **no data on disk**. All state is in-memory and resets when the host app closes.

---

## Log file

Nearby writes a log to the same app data directory: `nearby.log`. Open it from the tray → **View log file**. Both the main process and the renderer write to this file via the `log` IPC channel.
