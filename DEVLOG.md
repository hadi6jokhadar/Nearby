# Nearby — Developer Log

Floating always-on-top team presence widget. No cloud, no login, no database.
Works over the public internet via an embedded localtunnel.

---

## What it does

- Any member can **create a team** → an embedded WebSocket server starts on their machine → localtunnel punches a deterministic public `wss://` URL → invite link is generated.
- Anyone with the invite link **joins the team** → connects to whoever currently holds the relay.
- Both sides see each other as colored circles. Green = online, gray = offline.
- Circles can be "paired" (click a peer circle to pair/unpair).
- **The relay is not tied to the creator.** If the creator closes the app, every other online member immediately races for the relay subdomain — whoever wins becomes the new relay and the rest reconnect to them within ≈7 s.
- All management (copy link, reset, quit) is in the system tray right-click menu.

---

## Tech stack

| Layer            | Library                                    |
| ---------------- | ------------------------------------------ |
| Desktop shell    | Electron 31                                |
| UI               | React 18 + Vite 5                          |
| WebSocket server | `ws` 8 (embedded in Electron main process) |
| Public tunnel    | `localtunnel` 2                            |
| UUIDs            | `uuid` 9                                   |

Single `package.json` — no separate frontend/backend packages.

---

## Running the app

### Development

**Prerequisites:** Node.js 20+, npm 9+

```
npm run dev
```

Starts Vite dev server (port 3000) + Electron simultaneously. DevTools open automatically on the setup window.

### Production build

```
npm run dist:win      # Windows NSIS installer  (unsigned, local only)
npm run dist:mac      # macOS DMG               (unsigned, local only)
npm run dist:linux    # Linux AppImage           (local only)
```

For a **signed + notarized** macOS build use `build.mjs` directly:

```bash
export APPLE_ID="..."
export APPLE_APP_SPECIFIC_PASSWORD="..."
export APPLE_TEAM_ID="..."
export GH_TOKEN="..."
node build.mjs --mac --publish
```

Output lands in `release/`. Configuration lives in `electron-builder.config.js` (passed explicitly via `--config` to avoid electron-builder v24 config-discovery issues).

> **Before rebuilding:** close the running Nearby app first (tray → Close Nearby), otherwise electron-builder can't overwrite the DLLs in `release\win-unpacked`.

---

## Project structure

```
electron.js          Main process — windows, tray, IPC, localtunnel
server.js            Embedded WebSocket server (runs inside main process)
preload.js           contextBridge — exposes narrow API to renderer
logger.js            File logger shared by main process and server

src/
  main.jsx           React entry point
  index.html         HTML shell (CSP: connect-src ws: wss:)
  App.jsx            Root component — hydrates state from disk, routes views
  views/
    SetupView.jsx    First-launch screen: Create Team / Join Team tabs
    WidgetView.jsx   Floating widget — peer circles, copy-link button, guest reconnect banner
  hooks/
    useWebSocket.js  WS lifecycle: connect, reconnect, PING, message dispatch
  store/
    state.js         Tiny pub/sub state store (no Redux)
  components/
    PeerCircle.jsx   Single colored circle component
  styles/
    app.css          All CSS — setup view, widget, dark mode

vite.config.js       root=src, outDir=../dist
package.json         build.files includes electron.js, server.js, preload.js, logger.js
```

---

## Architecture

```
Every member runs this same stack:

┌─────────────────────────────────────────────┐
│  Electron Main Process (electron.js)        │
│                                             │
│  ┌──────────────┐   ┌────────────────────┐  │
│  │  server.js   │   │  localtunnel       │  │
│  │  ws on :4993 │◄──│  wss://nearby-XYZ… │  │  ← relay winner
│  └──────────────┘   └────────────────────┘  │
│         │ IPC (contextBridge)               │
└─────────┼───────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────┐
│  Renderer (React)                           │
│                                             │
│  App.jsx                                    │
│    └─ SetupView  or  WidgetView             │
│         └─ useWebSocket.js                  │
│              └─ WebSocket to localhost:4993 │  ← role=host (relay winner)
│              └─ WebSocket to wss://loca.lt  │  ← role=guest (all others)
└─────────────────────────────────────────────┘
```

**Relay ownership:** on startup every member races to acquire the same deterministic tunnel subdomain (`maxAttempts=2`, < 5 s). The winner becomes `role=host` and serves the channel. Losers connect as `role=guest`. If the relay goes offline, every guest races for the subdomain immediately on disconnect — the first to win becomes the new relay and the others reconnect to it within ≈7 s. The `role` field in `state.json` is updated dynamically; it does not permanently assign the relay to the creator.

### Two windows

- **Setup window**: 420×520, framed, normal. Shows on first launch or after reset.
- **Widget window**: 172px wide, frameless, transparent, always-on-top, no taskbar entry. Shows after team is created/joined.

These are separate `BrowserWindow` instances. Switching between them is done via IPC (`open-widget`, `open-setup`). The outgoing window is closed with `setImmediate(() => win.close())` to avoid a race where the renderer is destroyed before the IPC reply is sent back.

### Deterministic tunnel subdomain

Every member derives the same stable subdomain from the shared channel UUID:

```javascript
"nearby-" + channelId.replace(/-/g, "").slice(0, 12);
// e.g. channelId "37b8afa6-d47f-…" → subdomain "nearby-37b8afa6d47f"
// → tunnel URL wss://nearby-37b8afa6d47f.loca.lt
```

This is the **single rendezvous point** for the whole team. All invite links embed this URL. On startup, `App.jsx` and `useWebSocket.js` (on takeover) both call `startServer` with this subdomain.

`electron.js` accepts a `maxAttempts` parameter controlling how many times to retry. The retry loop only continues when the subdomain is honored on a later attempt (i.e., loca.lt's release window resolves); it exits immediately on "subdomain not honored" — meaning another relay already holds it. Callers use `maxAttempts=2` for startup races and `maxAttempts=4` for in-session takeovers. If all attempts fail, `subdomainHonored: false` is returned and the caller falls back to connecting as a guest.

When the tunnel closes unexpectedly (loca.lt hiccup, network blip), `scheduleTunnelReacquire()` fires after 3 s and reattempts acquisition silently in the background — up to 6 more tries with the same back-off. The renderer is notified via the `tunnel-reacquired` IPC event when the subdomain is restored.

### State persistence

`state.json` in Electron's `userData` folder (e.g. `%AppData%\Roaming\Nearby`). Written on every meaningful change. On next launch `App.jsx` reads it and decides which window to open.

### Invite link format

```
nearby://join/{base64url(JSON.stringify({ ws, channelId }))}
```

- `ws` = the **deterministic** `wss://nearby-{channelId}.loca.lt` URL — always, regardless of who generated the link or what tunnel they currently hold. This means the link stays valid even after the creator restarts or another member takes over the relay.
- `channelId` = UUID that namespaces the team on the server
- base64url: `+` → `-`, `/` → `_`, padding stripped
- On Windows/Linux, deep links are passed as a CLI argument (`process.argv`). The main process captures them in `pendingDeepLink` and forwards to the renderer via `ipcRenderer.send('deep-link', url)`.
- Any member can generate and share the invite link — it is not restricted to the current relay owner.

### Presence detection

- Every peer sends a `PING` every 5 seconds.
- The server relays PINGs to all other peers in the channel.
- Each receiver calls `touchPeerLastSeen(userId)`.
- A timer checks every 3 seconds — peers not seen in 15 seconds flip to `online: false` (gray).

### Sync protocol

Every peer broadcasts a `SYNC_CHECK` every 5 seconds containing their highest `updatedAt` timestamp across all peers and relationships. Any receiver that sees a higher timestamp than their own sends back a `REQUEST_SYNC` targeted at that peer. The target responds with a full `STATE_RESPONSE` containing all known peers and relationships. This keeps late-joiners and briefly-disconnected peers consistent without a central store.

### Conflict resolution

`upsertPeer` compares `updatedAt` timestamps. Incoming data only overwrites stored data if `incoming.updatedAt >= stored.updatedAt`.

---

## WebSocket message protocol

| Message               | Direction                    | Purpose                                                                          |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `HELLO`               | client → server              | Register on connect; triggers `COLOR_ASSIGN` + `PEER_JOINED` broadcast           |
| `COLOR_ASSIGN`        | server → client              | Server assigns a unique color from the palette                                   |
| `PEER_JOINED`         | server → all others          | Someone new connected; triggers `STATE_RESPONSE` from the existing peer          |
| `STATE_RESPONSE`      | client → server → target     | Full peer + relationship list sent to a specific peer (on join or sync response) |
| `SYNC_CHECK`          | client → server → all others | Broadcast own data version (`max(updatedAt)`); receivers request sync if behind  |
| `REQUEST_SYNC`        | client → server → target     | Ask a specific peer to send their full state                                     |
| `PING`                | client → server → all others | Heartbeat relay                                                                  |
| `UPDATE`              | client → server → all others | Name changed                                                                     |
| `PAIR`                | client → server → all others | Paired/unpaired with another peer                                                |
| `RELATIONSHIP_UPDATE` | client → server → all others | Working-with / waiting-for relationship changed                                  |
| `PEER_OFFLINE`        | server → all                 | TCP close detected                                                               |
| `RESET`               | host → server → all          | Wipe channel; all guests open setup window                                       |

**Server routing note:** every message must include a top-level `userId` field (the sender's ID). The server guard `if (!type || !channelId || !userId) return` silently drops messages missing this field. `STATE_RESPONSE` and `REQUEST_SYNC` are routed with `sendTo(channel, targetUserId, msg)` rather than broadcast.

---

## IPC surface (preload.js → electron.js)

| Call                                          | What it does                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readState()`                                 | Read `state.json`                                                                                                                                                                                                                                                                                                                                                    |
| `writeState(data)`                            | Write `state.json` + refresh tray menu                                                                                                                                                                                                                                                                                                                               |
| `deleteState()`                               | Delete `state.json` + refresh tray menu                                                                                                                                                                                                                                                                                                                              |
| `startServer(port, subdomain?, maxAttempts?)` | Start WS server + open localtunnel with optional subdomain; returns `{ ok, tunnelUrl, subdomainHonored }`. Serialized via an in-flight mutex so concurrent calls queue. Retries EADDRINUSE up to 3 times (1.5 s / 3 s gaps) to handle Windows port-release timing. Stops immediately on "subdomain not honored". Any member may call this to attempt relay takeover. |
| `stopServer()`                                | Close tunnel + WS server; clears `currentSubdomain` and cancels any pending reacquire timer                                                                                                                                                                                                                                                                          |
| `getLocalIP()`                                | Returns first non-internal IPv4 (LAN fallback)                                                                                                                                                                                                                                                                                                                       |
| `resizeWidget(height)`                        | Resize widget window height to content                                                                                                                                                                                                                                                                                                                               |
| `openWidget()`                                | Open widget window, close setup window                                                                                                                                                                                                                                                                                                                               |
| `openSetup()`                                 | Open setup window, destroy tray, close widget window                                                                                                                                                                                                                                                                                                                 |
| `getDeepLink()`                               | Return pending deep link (captured before renderer loaded)                                                                                                                                                                                                                                                                                                           |
| `onDeepLink(cb)`                              | Subscribe to live deep links; **returns the bound listener token** — pass the token (not the original callback) to `offDeepLink`                                                                                                                                                                                                                                     |
| `offDeepLink(token)`                          | Unsubscribe the listener returned by `onDeepLink`                                                                                                                                                                                                                                                                                                                    |
| `onRelayDemoted(cb)`                          | Fires when the main process permanently loses the relay subdomain (all reacquire attempts exhausted); renderer should switch to guest and reconnect                                                                                                                                                                                                                  |
| `offRelayDemoted(token)`                      | Unsubscribe the listener returned by `onRelayDemoted`                                                                                                                                                                                                                                                                                                                |
| `onTrayAction(cb)`                            | Subscribe to tray menu actions (`'reset'`)                                                                                                                                                                                                                                                                                                                           |
| `updateTray()`                                | Tell main process to rebuild the tray context menu                                                                                                                                                                                                                                                                                                                   |
| `log(ctx, msg)`                               | Write a log line to `nearby.log` from the renderer                                                                                                                                                                                                                                                                                                                   |

---

## Tray menu

Right-click the tray icon:

- **Copy invite link** — shown for any member that has a `channelId` in state (not restricted to the current relay owner); always embeds the deterministic URL
- **Reset team…** / **Leave team** — confirmation dialog, then sends `tray-action: 'reset'` to the renderer which calls `sendReset()` → `deleteState()` → `openSetup()`
- **Open DevTools** — detached DevTools for the active window
- **View log file** — opens `nearby.log` in the default text editor
- **Close Nearby** — `app.quit()`

---

## Logging

Log file: `%AppData%\Roaming\Nearby\nearby.log` (Windows).
Access via tray → View log file.

Format: `[ISO timestamp] [context] message`

Contexts logged:

- `main` — app startup, server start, tunnel URL, IPC events
- `server` — TCP connections, HELLO/RESET/UPDATE events, disconnects
- `ws` — every WebSocket event in the renderer: connect, HELLO sent, every incoming message type with key fields, disconnect codes
- `bypass` — every `.loca.lt` request that gets the bypass header injected

---

## Key bugs fixed

### `logger.js` not in ASAR

`package.json` `build.files` didn't include `logger.js`. Fixed by adding it.

### localtunnel bypass header not firing

Used `wss://*.loca.lt/*` as a URL filter pattern for `webRequest.onBeforeSendHeaders`. Electron maps `wss://` connections to `https://` internally, so the pattern never matched. Fixed: removed the filter entirely and used `details.url.includes('.loca.lt')` inside the callback.

### Widget scrollbars

`overflow: auto` on the body caused scrollbars when widget content overflowed. Fixed: `html, body { overflow: hidden }` in `app.css`.

### Reset not returning to setup window

Reset only changed the React view state inside the existing 90px frameless widget window. Setup rendered inside a tiny, frameless, always-on-top window. Fixed: `open-setup` IPC handler opens a proper 420×520 framed window and closes the widget.

### IPC reply race condition

Closing the sending window inside the IPC handler destroyed the renderer before the reply was delivered, so `await openWidget()` / `await openSetup()` in the renderer never resolved. Fixed: `setImmediate(() => win.close())` defers the close until after the reply is queued.

### Tunnel URL changes every session

`localtunnel` gives a new subdomain each time the server starts. On app restart the saved `wsUrl` is stale. Fixed in `App.jsx`: if role is `host`, `startServer` is called on hydration with the deterministic subdomain and the fresh tunnel URL is written back to `state.json` before the WebSocket connects.

### Guests see empty team after joining / sync never converges

`STATE_RESPONSE` and `REQUEST_SYNC` messages were built without a top-level `userId` field. The server guard (`if (!type || !channelId || !userId) return`) silently dropped them before routing, so guests never received any state and their data version stayed at `0` forever. Same bug also affected `RELATIONSHIP_UPDATE`. Fixed by adding `userId: self.userId` to all four message payloads in `useWebSocket.js`.

### Guests can't reconnect after host restarts (first fix)

When the host restarted, localtunnel sometimes assigned a random subdomain instead of the requested deterministic one. The guest's saved `wsUrl` (from the previous session) was then stale. Three-part fix:

1. **`electron.js`**: retry tunnel creation up to 3 times (2 s apart) when the subdomain isn't honored.
2. **`App.jsx`**: on guest startup, always override the saved `wsUrl` with the channel-derived URL before connecting.
3. **`useWebSocket.js` / `WidgetView.jsx`**: after 3 consecutive failed connection attempts, show a reconnect banner so the guest can paste a fresh invite link.

### Team goes offline when relay owner closes the app (second fix — relay resilience)

The first fix above improved single-restart reliability but left a structural problem: the relay was permanently owned by the team creator. If they closed the app, all other members entered an infinite reconnect loop with no way to recover. Root causes:

1. **Tunnel subdomain retry too low** — 3 attempts (6 s total) is not enough. loca.lt can take 10–40 s to release a recently-closed subdomain.
2. **Single-owner relay** — only the original creator ever called `startServer`. Guests had no path to self-promote.
3. **Ephemeral URL in invite links** — if the creator's 3 retries all failed, they received a random tunnel URL. That URL was embedded in the invite link, so pasting the link gave members a URL that pointed nowhere.

Full fix across five files:

**`electron.js`**

- `start-server` retries increased from 3 to **10** with stepped back-off (2 s → 3 s → … → 8 s max). Total wait ≈ 50 s, covering loca.lt's observed release window.
- `start-server` now returns `{ ok, tunnelUrl, subdomainHonored }` so callers know definitively whether they won the subdomain race.
- If the server is already running with a wrong-subdomain tunnel, it closes that tunnel and competes for the right one — enabling relay takeover without a server restart.
- `scheduleTunnelReacquire()` — when the tunnel closes unexpectedly (network blip, loca.lt hiccup), the server silently attempts to reacquire the same subdomain after 3 s (up to 6 more retries). Fires `tunnel-reacquired` IPC event on success.
- `currentSubdomain` module var tracks which subdomain the process is competing for. Cleared on `stop-server` and `before-quit`.
- `buildInviteLinkMain` — always embeds the **deterministic** URL, never the ephemeral tunnel URL.

**`App.jsx`**

- Every member (not just the original creator) calls `startServer` on hydration and competes to acquire the deterministic subdomain.
- `role: 'host'` is set dynamically when `subdomainHonored === true`; otherwise `role: 'guest'` with `wsUrl` pointing to the deterministic URL.
- LAN-only mode (no tunnel) preserved: hosts refresh their local IP, guests keep the stored LAN URL.

**`useWebSocket.js`**

- After exactly 3 failed reconnects, a guest attempts **relay takeover** once: calls `startServer` with the channel subdomain. If successful → switches `role` to `host`, updates `state.json`, reconnects to `localhost`. If not → sets `guestUnreachable: true` and resumes the normal 5 s retry loop.
- `isAttemptingTakeover` ref prevents duplicate concurrent takeover attempts.
- `isAttemptingTakeover` resets on any successful `onopen`.

**`SetupView.jsx`**

- `handleJoin` now derives the `wsUrl` from the `channelId` in the invite link (deterministic URL) rather than copying the `ws` field verbatim. LAN URLs (non-loca.lt) are kept as-is.

**`WidgetView.jsx`**

- `buildInviteLink` uses the deterministic URL; available to any member (removed `role !== 'host'` guard).
- `handleRelink` (paste-link-to-reconnect form) also uses the deterministic URL, so pasting any valid invite link for the same channel works regardless of which URL the sender currently holds.
- Reconnect banner `guestUnreachable` check removed role guard — shown for any member when the relay is unreachable.
- Banner message updated: "Team relay offline. Auto-reconnecting… or paste an invite link to retry."

**Steady-state behavior after fix:**

- All members start → one acquires the subdomain → others connect as guests.
- Relay closes → guests retry for ~15 s → first to attempt takeover acquires subdomain → others reconnect to them.
- All members restart after any gap → first to start acquires subdomain → others auto-connect when they start.
- Invite links are permanently valid (same channel = same URL).

### Guest join blocks on relay race — widget invisible until race ends (third fix)

**Symptoms:** After joining a team (or on any restart as a guest), the app appeared to disappear. The widget window existed in the system tray but clicking the tray icon showed nothing. The guest was also not connecting to the host.

**Root causes:**

1. **`App.jsx` called `startServer` for everyone on hydration**, including guests who had just joined and had no reason to compete for the relay. `startServer` retries the localtunnel subdomain up to 10 times (≈50 s back-off). During this time the widget was stuck on an invisible transparent loading screen — the 172×420 frameless window showed nothing and the user saw the app as "gone".

2. **The widget window was created without `show: false`**, so Electron showed a transparent blank frame immediately, before React rendered any content. The tray icon appeared (via `ready-to-show`) but clicking it just focused an empty transparent window.

3. **`handleJoin` / `handleCreate` in `SetupView.jsx` called `setState({ view: 'widget' })`** before `openWidget()`. This mounted `WidgetView` — and therefore `useWebSocket` — inside the dying setup window, adding a spurious connection attempt that was torn down milliseconds later when the setup window closed.

**Fix (three files):**

**`App.jsx`**

- Guests skip `startServer` on hydration entirely. They connect straight to the deterministic relay URL. `useWebSocket`'s existing relay-takeover logic (after 3 failures, ≈15 s) handles promotion if the relay is down. Net result: the widget is visible in under a second instead of after ≈50 s.
- `wsUrl` is still normalised to the deterministic URL on each guest startup to guard against stale ephemeral URLs in `state.json`.
- Non-guest members (previously held the relay) still call `startServer` so they can reclaim the subdomain quickly on restart.

**`electron.js`**

- Widget window now uses `show: false`. It is shown explicitly in `ready-to-show`, so Electron never displays the blank transparent frame.
- Tray click adds `isMinimized()` → `restore()` guard before `show()` / `focus()`.

**`SetupView.jsx`**

- `handleJoin` and `handleCreate` no longer call `setState({ view: 'widget' })` or `onComplete`. The widget window's own `App.jsx` manages its state; the setup window just waits to be closed.

### Relay takeover fires once and never retries — permanent outage after one failed takeover (fourth fix)

**Symptoms:** If the relay owner closes the app and no other member immediately wins the subdomain race (loca.lt slow to release), the remaining guests enter a permanent offline state. The reconnect banner shows but the team never recovers on its own, even if all guests restart.

**Root causes:**

1. **`useWebSocket.js` triggered takeover at exactly `reconnectCount === 3` — and only once.** After count incremented past 3, the condition was never true again, so a failed first takeover meant no further attempts ever.

2. **`App.jsx` skipped `startServer` for all guests on startup (third fix regression).** If all members close the app and reopen it, only the member whose saved `role` was `host` competed for the relay. Everyone else connected as a guest directly — meaning the first person to open the app mattered more than whether a relay was even reachable.

3. **`startServer` had no `maxAttempts` parameter.** All callers (startup, takeover) used 10 retries with stepped back-off (up to ≈50 s). The right number of retries differs: startup races want to be fast (2 attempts); in-session takeovers want moderate persistence (4 attempts).

**Fix (four files):**

**`electron.js`**

- `start-server` IPC now accepts a third parameter `maxAttempts` (default 5). The retry loop runs at most `maxAttempts` times. Callers pass lower values for speed or higher values for robustness.

**`preload.js`**

- `startServer(port, subdomain, maxAttempts)` passes the third argument through to the IPC handler.

**`App.jsx`**

- **All members race on startup** regardless of saved `role`, using `maxAttempts=2` (< 5 s total). The first member whose localtunnel request is honored becomes the relay host; the others immediately get back a wrong subdomain and connect as guests. This replaces both the "only former hosts race" path and the "guests always skip" fast-path. Startup time: < 5 s in all cases.
- LAN-only mode detected (`wsUrl` is a local IP) and handled separately: LAN host refreshes local IP and restarts the WS server; LAN guests keep their stored URL.

**`useWebSocket.js`**

- Takeover now triggers at `reconnectCount === 2` (after ≈10 s offline, down from 15 s).
- Uses `maxAttempts=4` for takeover `startServer` — gives loca.lt up to ≈12 s to release the subdomain while keeping total takeover time reasonable.
- **Counter resets to 0 on a failed takeover** (previously it was left unchanged, making `count === 3` permanently false). The takeover now retries every 2 more reconnect failures until someone wins or the relay comes back on its own.
- `guestUnreachable: true` (reconnect banner) is set when the first takeover begins, not after an arbitrary count threshold.

---

### Takeover too slow — winner not detected by losers for up to 21 s (fifth fix)

**Symptoms:** When the relay goes offline and multiple guests race for it, the first guest to win becomes the new relay almost instantly. But the losing guests were still burning through up to four `startServer` attempts with 3.5 s–5.5 s back-offs between each, keeping them offline for ≈21 s after the winner was already serving — even though each individual attempt was fast (the winning relay immediately caused loca.lt to return a wrong subdomain to every loser).

Two separate root causes worked together to produce this delay:

1. **Takeover waited for 2 failed reconnects before starting (≈10 s dead time).** The wait was intended as a blip filter, but a clean WS close means the relay is genuinely gone, so any wait just delays recovery with no benefit.

2. **`startServer` kept retrying after a "subdomain not honored" response.** loca.lt returns "not honored" immediately when the subdomain is actively held. Retrying after that just burns back-off time (3.5 s, 4.5 s, 5.5 s…) with no chance of winning — the relay is held until its owner closes it.

**Fix (two files):**

**`useWebSocket.js`**

- Takeover now starts **immediately on the first disconnect**, with no failure-count threshold. `isAttemptingTakeover` still prevents concurrent attempts from the same process.
- `reconnectCountRef` removed (no longer needed for any logic).
- If the takeover fails, the member reconnects as a guest after 5 s. If that reconnect also fails (relay still down), `onclose` fires again and a new takeover attempt starts immediately. This creates a natural retry cycle driven by the reconnect loop rather than an internal counter.
- `guestUnreachable: true` is set at the moment the first takeover begins.

**`electron.js`**

- When `startServer` gets a "subdomain not honored" response, it **breaks out of the retry loop immediately** instead of waiting for the next back-off slot. The winner is already holding the subdomain; further retries cannot change that outcome.
- The reconnect cycle (above) is now the retry mechanism for the loca.lt release-window case. Each disconnect → immediate single attempt → if not honored → reconnect as guest → if relay still down → disconnect → immediate attempt → … This is faster and more responsive than an internal loop with fixed back-offs.

**Steady-state behavior after both fixes:**

- Relay closes → all guests race immediately (no 10 s wait).
- One guest wins the subdomain → becomes relay host in ≈2–5 s.
- All losing guests get "subdomain not honored" on their first attempt, stop immediately, reconnect to the new relay in ≈5 s.
- **Total offline time for losing guests: ≈7 s** (vs. ≈21 s before).
- If loca.lt is slow to release the subdomain (host just closed), each guest retries every ≈7 s automatically until one wins.
- All members close and reopen → first to open races (< 5 s) → others connect as guests when they open.
- Invite links remain permanently valid (deterministic URL, unchanged across relay handoffs).

### Intermittent connect failures on relaunch — EADDRINUSE, mutex, force-close, split-relay (sixth fix)

**Symptoms:** Users closing and reopening the app sometimes got stuck in an infinite loop of WebSocket 1006 errors. The widget loaded but never connected. On the host side the server appeared to start successfully, but guests could not reach it. Additionally, in multi-member teams where the relay machine stayed online for a long time, the relay could become permanently unreachable — alive locally but with a stale or unroutable tunnel — with no recovery path.

**Root causes:**

1. **`startServer` was synchronous — EADDRINUSE silently swallowed.** `server.js` returned the `WebSocketServer` object before TCP bind completed. Any `error` event (including `EADDRINUSE` from a port already in use by a recently closed prior instance) fired after the caller had already moved on. The port was marked as in use and the server never actually listened, but the IPC response was `{ ok: true }`.

2. **No mutex on concurrent `start-server` IPC calls.** If two `BrowserWindow` instances (e.g. setup and widget) both called `startServer` at startup, both could race through the IPC handler simultaneously and attempt to bind the same port, reliably producing EADDRINUSE.

3. **`closeServer()` didn't exist.** `wss.close()` stops accepting new connections but waits for all existing clients to disconnect before releasing the port. On quick restarts the port was still in use when the next instance tried to bind — another EADDRINUSE source.

4. **Split-relay dead-end.** When `scheduleTunnelReacquire` exhausted all 6 attempts after a tunnel close, it gave up silently. The host kept running a WS server on port 993, but loca.lt's released subdomain had been grabbed by another member. The host was isolated: it served a channel that nobody could reach, and it never released the port or notified anyone. The team was permanently split.

5. **Orphaned wrong-URL tunnel.** When `handleStartServer` got back a tunnel whose URL didn't match the requested subdomain (another member already held it), it stored the wrong tunnel in the `tunnel` module variable instead of closing it immediately. This caused spurious `scheduleTunnelReacquire` cycles on every subsequent tunnel-close event for a tunnel the process never actually wanted.

6. **`offDeepLink` never removed the listener.** `onDeepLink` wrapped the caller's callback in a closure (`(_, url) => cb(url)`) but returned the original `cb`. `offDeepLink(cb)` called `removeListener` with `cb`, which is a different function reference from the wrapper — so the listener accumulated on every render cycle, leaking memory and causing the same deep link to fire multiple times.

7. **`guestUnreachable` banner on every first disconnect.** The reconnect banner appeared immediately on the first connection failure — a transient network blip — instead of after a confirmed sustained outage.

8. **Host recovery port-release race.** The host recovery path in `useWebSocket` called `stopServer()` (graceful close), then immediately called `startServer()`. On Windows, `wss.close()` returns before the OS releases the TCP port, so the next bind got EADDRINUSE.

**Fix (five files):**

**`server.js`**

- `startServer` now returns a `Promise` that resolves on the `listening` event and rejects on the `error` event. All callers `await` it, so EADDRINUSE and other bind errors are now properly propagated as rejections rather than silently lost.

**`electron.js`**

- `closeServer()` helper added: iterates all connected WS clients, terminates each with `ws.terminate()`, then calls `wss.close()`. Terminate (vs. `close`) skips the graceful handshake and releases the port immediately. Called on `widgetWindow.closed` and `app.before-quit`.
- `handleStartServer(port, subdomain, maxAttempts)` async function: wraps the `startServer` + localtunnel flow. Contains a dedicated EADDRINUSE retry loop (up to 3 attempts, 1.5 s then 3 s gaps) to absorb Windows port-release timing after a quick restart.
- `startServerInFlight` mutex: the `start-server` IPC handler awaits any in-flight invocation before starting a new one, serializing concurrent calls.
- `scheduleTunnelReacquire` demotion path: after 6 failed reacquire attempts, instead of giving up silently — closes the stale tunnel, calls `closeServer()`, clears `currentSubdomain`, and sends a `relay-demoted` IPC event to the renderer. The process fully exits the relay role.
- `handleStartServer` orphaned-tunnel fix: when the returned tunnel URL doesn't match the requested subdomain (`!subdomainHonored`), the wrong tunnel is closed immediately and `{ ok: true, tunnelUrl: null, subdomainHonored: false }` is returned. The tunnel is never stored.
- Port default changed from **4993 → 993** throughout (`scheduleTunnelReacquire` opts, IPC defaults).
- `buildAppMenu()` added: constructs a native OS menu bar (File / Edit / View / Window / Help). **Help → View Log** opens `nearby.log` via `shell.openPath`. Called in `app.whenReady()`.

**`preload.js`**

- `onTunnelReacquired` removed (was dead code — never subscribed in renderer).
- `onDeepLink` now returns the bound wrapper function; `offDeepLink` accepts that token directly (no more closure identity mismatch).
- `onRelayDemoted(cb)` / `offRelayDemoted(token)` added: exposes the new `relay-demoted` IPC event to the renderer.

**`src/hooks/useWebSocket.js`**

- `relay-demoted` effect: subscribes to `onRelayDemoted`; on receipt, switches local state to `role: guest`, writes `state.json`, and immediately reconnects to the deterministic relay URL. Cleanup calls `offRelayDemoted(token)`.
- `guestFailCountRef` added: increments on each consecutive guest disconnect; the `guestUnreachable` banner is only shown after the **2nd** consecutive failure (transient blips no longer trigger it).
- `hostFailCountRef` added: after 5 consecutive host-side WS failures, triggers server recovery: `stopServer()` → 500 ms pause (port-release window) → `startServer(subdomain, 5)`. If the restart fails, demotes to guest.
- Both counters reset to `0` on `ws.onopen`.

**`src/views/SetupView.jsx`**

- `onDeepLink` cleanup stores the returned token and passes it to `offDeepLink` in the `useEffect` return.

**Steady-state behavior after sixth fix:**

- App restarted quickly → EADDRINUSE absorbed by retry loop; server binds successfully within 3–6 s.
- Two windows race `startServer` on the same launch → mutex serializes them; second call sees server already running and returns early.
- App quit → all clients force-terminated instantly; port released before OS cleanup; next launch binds cleanly.
- Relay permanently lost (all reacquire attempts exhausted) → host demotes itself, shuts down server, renderer switches to guest and reconnects to whoever now holds the relay.
- Deep link cleanup works: listener properly removed on `useEffect` unmount; no duplicate firings.
- Transient network blip → no spurious banner; banner only appears after the 2nd consecutive failure.

---

## App menu bar

A native OS menu bar is shown above the window (always visible on macOS; visible on focus on Windows/Linux). Registered via `Menu.setApplicationMenu` in `electron.js` → `buildAppMenu()`.

| Menu       | Items                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| **File**   | Close (macOS) / Quit (Windows/Linux)                                       |
| **Edit**   | Undo, Redo, Cut, Copy, Paste, Select All                                   |
| **View**   | Reload, Toggle DevTools, Actual Size, Zoom In, Zoom Out, Toggle Fullscreen |
| **Window** | Minimize, Zoom (macOS), Bring All to Front (macOS)                         |
| **Help**   | **View Log** — opens `nearby.log` in the default text editor               |

---

## Color palette (server-assigned)

```
#7F77DD  #1D9E75  #D85A30  #D4537E
#378ADD  #639922  #BA7517  #E24B4A  #888780
```

Server assigns colors round-robin from this list. On disconnect the color slot is freed (last color popped off `usedColors`).

---

## Code signing and notarization

### macOS — Developer ID + Notarization

The macOS DMG is signed with an **Apple Developer ID Application** certificate and notarized via Apple's notary service so Gatekeeper accepts it without any warning.

**Key files:**

| File | Purpose |
|------|---------|
| `electron-builder.config.js` | electron-builder config (JS so `APPLE_TEAM_ID` env var can be read at build time) |
| `entitlements.mac.plist` | Hardened runtime entitlements: JIT, unsigned executable memory, network client |

**How signing works:**

electron-builder v24 has built-in notarization support. Setting `notarize: { teamId }` in the mac config is enough — no separate `@electron/notarize` package needed. The config reads `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` from env vars automatically.

The `--config electron-builder.config.js` flag is passed explicitly to all `electron-builder` calls (both in `build.mjs` and in the GitHub Actions workflow) to bypass electron-builder v24's config-file discovery, which failed to auto-detect the JS config file.

**Verification:**

```bash
hdiutil attach Nearby-X.Y.Z-arm64.dmg
xcrun stapler validate "/Volumes/Nearby X.Y.Z-arm64/Nearby.app"   # → The validate action worked!
spctl --assess --verbose "/Volumes/Nearby X.Y.Z-arm64/Nearby.app" # → accepted (source=Notarized Developer ID)
```

### Windows — SignPath (Authenticode)

Windows Authenticode signing is handled by [SignPath](https://signpath.io) (free open-source plan) via their PowerShell module in GitHub Actions.

**Flow:**
1. electron-builder packages the unsigned NSIS installer (`CSC_IDENTITY_AUTO_DISCOVERY=false` skips any local cert).
2. The PowerShell step installs the `SignPath` module from PSGallery and calls `Submit-SigningRequest`, which uploads the unsigned `.exe` to SignPath, waits for it to be signed, and writes the signed file to `release/signed/`.
3. A second PowerShell step computes the SHA-512 of the signed exe and writes `latest.yml` (for `electron-updater` auto-update).
4. `softprops/action-gh-release@v2` publishes both files to the GitHub Release.

**SignPath project config:**
- Organization ID: `a819449d-c11d-486c-aa45-f028e771412d`
- Project slug: `nearby`
- Signing policy slug: `test-release-signing`
- Artifact configuration slug: `initial`
- Artifact configuration file: `windows-installer.xml` (signs inner Nearby.exe, inner PE files, and the NSIS wrapper)

### CI/CD — GitHub Actions

Both platforms build and publish in parallel on every `v*` tag push. Publishing uses the built-in `github.token` — no personal access token needed.

**Triggering a release** is done via `release.mjs`:

```bash
npm run release          # patch bump + push tag
npm run release:minor    # minor bump + push tag
npm run release:major    # major bump + push tag
node release.mjs 1.2.3   # exact version
```

The script validates git state, bumps `package.json` + `package-lock.json` via `npm version`, commits, tags, and pushes. GitHub Actions triggers on the tag.

Required secrets (Settings → Secrets and variables → Actions):

| Secret | Used by |
|--------|---------|
| `APPLE_CERTIFICATE` | macOS — base64-encoded `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | macOS — `.p12` export password |
| `APPLE_ID` | macOS — Apple ID email for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS — app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | macOS — 10-char Team ID from developer.apple.com |
| `SIGNPATH_API_TOKEN` | Windows — SignPath API token for Authenticode signing |

---

## Known limitations / possible next steps

- **Tunnel reliability**: localtunnel is a free public service with no SLA. If `loca.lt` is down entirely, the startup race fails immediately (one attempt, no tunnel returned) and the app falls back to LAN-only — members on different networks can't find each other until loca.lt recovers. Could swap for `ngrok` or a self-hosted tunnel (e.g. Cloudflare Tunnel) for higher reliability.
- **Subdomain race not 100% guaranteed**: in the edge case where loca.lt can't honor the deterministic subdomain for any member after all retries, no relay is established and the team is unreachable. Frequency: rare in practice. Mitigation: the reconnect banner lets any member manually paste a link to retry.
- **Single channel per machine**: each member runs one WS server on port 4993. Two Nearby instances on the same machine would conflict on that port.
- **No invite link expiry**: the link is valid indefinitely (same channel = same deterministic URL). There is no token or TTL — anyone who has the link can join.
- **Color freed on disconnect is the wrong slot**: `usedColors.pop()` removes the _last_ color added, not the disconnected peer's specific color. If peers join in order A-B-C and B disconnects, C's color slot is freed instead of B's. Low impact but can cause unexpected color reuse.
- **Relay role not broadcast to peers**: when a guest promotes to relay, the other peers update via reconnection but there is no explicit message announcing the new relay owner. The tray menu "Reset team" option stays tied to `role === 'host'` in local state, so after auto-promotion the new relay owner correctly gets "Reset team" while original guests keep "Leave team".
