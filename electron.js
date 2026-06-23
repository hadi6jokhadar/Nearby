// electron.js — Electron main process

const {
  app, BrowserWindow, ipcMain, session,
  net: electronNet,
  Tray, Menu, clipboard, nativeImage, dialog, shell,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const zlib = require('zlib');
const localtunnel = require('localtunnel');
const nodeTcpNet  = require('net');
const { startServer } = require('./server');
const { log, setLogPath } = require('./logger');
const { autoUpdater }     = require('electron-updater');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// localtunnel() can hang indefinitely when loca.lt is slow or unreachable.
// This wrapper rejects after timeoutMs so callers can fall back to LAN-only.
function localtunnelWithTimeout(opts, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`localtunnel timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    localtunnel(opts).then(
      (lt) => { clearTimeout(timer); resolve(lt); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ─── State ────────────────────────────────────────────────────────────────────

let wss    = null;
let tunnel = null;
let tray   = null;
let setupWindow  = null;
let widgetWindow = null;
let currentSubdomain    = null;
let currentPort         = 4993;
let reacquireTimer      = null;
let bgTunnelTimer       = null; // background tunnel retry after initial failure
let startServerInFlight = null; // mutex for concurrent start-server IPC calls

const STATE_FILE = path.join(app.getPath('userData'), 'state.json');
const LOG_FILE   = path.join(app.getPath('userData'), 'nearby.log');
const IS_DEV     = process.env.NODE_ENV === 'development';

// 'idle' | 'checking' | 'available' | 'downloading' | 'ready'
let updateState = 'idle';

// Start writing to the log file as early as possible
setLogPath(LOG_FILE);
log('main', `Nearby starting. userData=${app.getPath('userData')}`);

// ─── Network access check ────────────────────────────────────────────────────

async function checkNetworkAccess() {
  // macOS: trigger an outbound socket early so the OS fires the network
  // permission dialog before any user-facing window appears.
  if (process.platform === 'darwin') {
    await new Promise((resolve) => {
      const sock = nodeTcpNet.createConnection({ host: 'loca.lt', port: 80, timeout: 3000 });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error',   () => { sock.destroy(); resolve(); });
      sock.once('timeout', () => { sock.destroy(); resolve(); });
    });
  }

  if (!electronNet.isOnline()) {
    dialog.showErrorBox(
      'No network access — Nearby',
      'Nearby needs network access to connect your team. Please allow network access and restart the app.',
    );
    app.quit();
    return false;
  }
  return true;
}

// ─── Deep-link (Windows/Linux: argv) ─────────────────────────────────────────

let pendingDeepLink = process.argv.find((a) => a.startsWith('nearby://')) || null;

// ─── Tray icon — programmatic 16×16 purple PNG ───────────────────────────────

function createTrayIconBuffer() {
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t   = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }
  const size = 16;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte + RGB
    for (let x = 0; x < size; x++) {
      row[1 + x * 3]     = 0x7F; // R  (#7F77DD)
      row[1 + x * 3 + 1] = 0x77; // G
      row[1 + x * 3 + 2] = 0xDD; // B
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Tray helpers ─────────────────────────────────────────────────────────────

function channelSubdomain(channelId) {
  return 'nearby-' + channelId.replace(/-/g, '').slice(0, 12);
}

function buildInviteLinkMain() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const { self } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (!self?.channelId || !self?.wsUrl) return null;
    // Use the stored wsUrl: local IP when tunnel is down, loca.lt when tunnel is up.
    const wsUrl = self.wsUrl;
    const payload = Buffer.from(JSON.stringify({ ws: wsUrl, channelId: self.channelId }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `nearby://join/${payload}`;
  } catch { return null; }
}

// Try to re-acquire the tunnel subdomain after an unexpected close.
// If another relay has permanently claimed the subdomain (all 6 attempts fail),
// shut down the local relay and notify the renderer to rejoin as a guest.
async function scheduleTunnelReacquire() {
  if (reacquireTimer) return;
  reacquireTimer = setTimeout(async () => {
    reacquireTimer = null;
    if (!wss || !currentSubdomain) return;
    log('main', `tunnel reacquire: attempting subdomain=${currentSubdomain}…`);
    try {
      const opts = { port: 4993, subdomain: currentSubdomain };
      let lt = null;
      for (let i = 1; i <= 6; i++) {
        if (lt) { lt.close(); await new Promise(r => setTimeout(r, Math.min(2000 * i, 10000))); }
        lt = await localtunnelWithTimeout(opts);
        log('main', `tunnel reacquire: created → ${lt.url}`);
        if (lt.url.includes(currentSubdomain)) break;
        if (i < 6) log('main', `tunnel reacquire: subdomain not honored (${i}/6)`);
      }

      if (!lt.url.includes(currentSubdomain)) {
        // Another relay now permanently holds the subdomain — we are isolated.
        // Shut down the local relay and tell the renderer to rejoin as a guest.
        log('main', 'tunnel reacquire: subdomain permanently taken — demoting to guest');
        lt.close();
        tunnel = null;
        currentSubdomain = null;
        closeServer();
        updateTrayMenu();
        const win = widgetWindow || setupWindow;
        if (win) win.webContents.send('relay-demoted');
        return;
      }

      tunnel = lt;
      tunnel.on('close', () => {
        log('main', 'tunnel closed');
        tunnel = null;
        updateTrayMenu();
        if (wss && currentSubdomain) scheduleTunnelReacquire();
      });
      tunnel.on('error', (err) => log('main', `tunnel error: ${err.message}`));
      log('main', `tunnel reacquired → ${tunnel.url}`);
      updateTrayMenu();
    } catch (err) {
      log('main', `tunnel reacquire failed: ${err.message}`);
    }
  }, 3000);
}

// Background tunnel acquisition: keeps retrying every 30 s after the initial
// attempt fails. When the tunnel eventually comes up it notifies the renderer
// via the 'tunnel-ready' IPC event so the UI can show the invite link.
function scheduleBackgroundTunnel() {
  if (bgTunnelTimer || tunnel || !wss || !currentSubdomain) return;
  log('main', 'bg-tunnel: scheduling retry in 15 s…');

  async function attempt() {
    bgTunnelTimer = null;
    if (!wss || tunnel || !currentSubdomain) return;
    log('main', `bg-tunnel: attempting subdomain=${currentSubdomain}…`);
    try {
      const lt = await localtunnelWithTimeout(
        { port: currentPort, subdomain: currentSubdomain },
        20000,
      );
      if (lt.url.includes(currentSubdomain)) {
        tunnel = lt;
        tunnel.on('close', () => {
          log('main', 'tunnel closed');
          tunnel = null;
          updateTrayMenu();
          if (wss && currentSubdomain) scheduleTunnelReacquire();
        });
        tunnel.on('error', (err) => log('main', `tunnel error: ${err.message}`));
        log('main', `bg-tunnel: ready → ${lt.url}`);
        updateTrayMenu();
        const win = widgetWindow || setupWindow;
        if (win) win.webContents.send('tunnel-ready', lt.url);
        return; // success — stop retrying
      }
      lt.close();
      log('main', 'bg-tunnel: subdomain not honored — another relay holds it');
    } catch (err) {
      log('main', `bg-tunnel: attempt failed (${err.message})`);
    }
    if (wss && !tunnel && currentSubdomain) {
      log('main', 'bg-tunnel: retrying in 30 s…');
      bgTunnelTimer = setTimeout(attempt, 30000);
    }
  }

  bgTunnelTimer = setTimeout(attempt, 15000);
}

function updateTrayMenu() {
  if (!tray) return;
  const inviteLink = buildInviteLinkMain();

  let role = null;
  try {
    if (fs.existsSync(STATE_FILE)) {
      role = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).self?.role;
    }
  } catch {}

  const items = [];

  if (widgetWindow) {
    const visible = widgetWindow.isVisible() && !widgetWindow.isMinimized();
    items.push({
      label: visible ? 'Hide widget' : 'Show widget',
      click() {
        if (!widgetWindow) return;
        if (widgetWindow.isMinimized()) widgetWindow.restore();
        if (widgetWindow.isVisible()) {
          widgetWindow.hide();
        } else {
          widgetWindow.show();
          widgetWindow.focus();
        }
        updateTrayMenu();
      },
    });
    items.push({ type: 'separator' });
  }

  if (inviteLink) {
    items.push({
      label: 'Copy invite link',
      click() { clipboard.writeText(inviteLink); },
    });
    items.push({ type: 'separator' });
  }

  if (role === 'host') {
    items.push({
      label: 'Reset team…',
      click() {
        if (!widgetWindow) return;
        const choice = dialog.showMessageBoxSync(widgetWindow, {
          type: 'warning',
          buttons: ['Reset', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: 'Reset team?',
          detail: 'This will disconnect everyone and wipe all local data.',
        });
        if (choice === 0) widgetWindow.webContents.send('tray-action', 'reset');
      },
    });
  } else if (role === 'guest') {
    items.push({
      label: 'Leave team',
      click() {
        if (!widgetWindow) return;
        const choice = dialog.showMessageBoxSync(widgetWindow, {
          type: 'question',
          buttons: ['Leave', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: 'Leave team?',
          detail: 'Your local data will be cleared.',
        });
        if (choice === 0) widgetWindow.webContents.send('tray-action', 'reset');
      },
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: updateState === 'ready'       ? 'Restart to update…'
         : updateState === 'checking'    ? 'Checking for updates…'
         : updateState === 'downloading' ? 'Downloading update…'
         : 'Check for updates',
    enabled: updateState === 'idle' || updateState === 'ready',
    click() {
      if (IS_DEV) return;
      if (updateState === 'ready') { autoUpdater.quitAndInstall(); return; }
      updateState = 'checking';
      updateTrayMenu();
      autoUpdater.checkForUpdates().catch((err) => {
        log('updater', `Manual check failed: ${err.message}`);
        updateState = 'idle';
        updateTrayMenu();
      });
    },
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Open DevTools',
    click() {
      const win = widgetWindow || setupWindow;
      if (win) win.webContents.openDevTools({ mode: 'detach' });
    },
  });
  items.push({
    label: 'View log file',
    click() { shell.openPath(LOG_FILE); },
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Launch at startup',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click(item) { app.setLoginItemSettings({ openAtLogin: item.checked }); },
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Close Nearby', click() { app.quit(); } });

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromBuffer(createTrayIconBuffer());
  tray = new Tray(icon);
  tray.setToolTip('Nearby');
  updateTrayMenu();
  tray.on('click', () => {
    if (!widgetWindow) return;
    if (widgetWindow.isMinimized()) widgetWindow.restore();
    widgetWindow.show();
    widgetWindow.focus();
  });
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// Force-terminate all WebSocket clients and close the server (fast port release).
// Use for app shutdown; NOT for graceful stop-server (which lets RESET broadcast first).
function closeServer() {
  if (!wss) return;
  for (const client of wss.clients) client.terminate();
  wss.close();
  wss = null;
}

// Core start-server logic, called through the mutex wrapper below.
async function handleStartServer(port, subdomain, maxAttempts) {
  // Server + tunnel already running with the correct subdomain — nothing to do.
  if (wss && tunnel) {
    const honored = !subdomain || tunnel.url.includes(subdomain);
    if (honored) {
      log('main', `start-server: already running, tunnelUrl=${tunnel.url}`);
      return { ok: true, tunnelUrl: tunnel.url, subdomainHonored: true };
    }
    // Server running but wrong tunnel — close it so we can compete for the right subdomain.
    log('main', `start-server: server running with wrong tunnel (${tunnel.url}), switching to ${subdomain}`);
    tunnel.close();
    tunnel = null;
  }

  // Start the WebSocket server if not already running.
  if (!wss) {
    log('main', `start-server: starting WS server on port ${port}`);
    // Retry up to 3× on EADDRINUSE — the previous session may not have released the port yet.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        wss = await startServer(port); // now returns a Promise; resolves only after actual bind
        log('main', 'start-server: WS server started OK');
        break;
      } catch (err) {
        wss = null;
        if (err.code !== 'EADDRINUSE' || attempt === 3) {
          log('main', `start-server: WS server failed: ${err.message}`);
          return { ok: false, tunnelUrl: null, subdomainHonored: false };
        }
        log('main', `start-server: port ${port} in use (attempt ${attempt}/3) — retrying in ${attempt * 1500}ms…`);
        await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
    if (!wss) return { ok: false, tunnelUrl: null, subdomainHonored: false };
  }

  currentPort = port;
  if (subdomain) currentSubdomain = subdomain;

  log('main', `start-server: creating localtunnel${subdomain ? ` subdomain=${subdomain}` : ''}…`);
  const tunnelOpts = { port };
  if (subdomain) tunnelOpts.subdomain = subdomain;
  let lastTunnel = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (lastTunnel) {
      lastTunnel.close();
      lastTunnel = null;
      await new Promise(r => setTimeout(r, Math.min(1500 + attempt * 1000, 8000)));
    }
    try {
      lastTunnel = await localtunnelWithTimeout(tunnelOpts);
    } catch (err) {
      log('main', `start-server: tunnel attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt >= maxAttempts) {
        scheduleBackgroundTunnel();
        return { ok: true, tunnelUrl: null, subdomainHonored: false };
      }
      continue;
    }
    log('main', `start-server: tunnel created → ${lastTunnel.url}`);
    if (!subdomain || lastTunnel.url.includes(subdomain)) break;
    // Subdomain not honored: another relay holds it. Discard and stop.
    log('main', `start-server: subdomain not honored on attempt ${attempt} — stopping`);
    lastTunnel.close();
    lastTunnel = null;
    return { ok: true, tunnelUrl: null, subdomainHonored: false };
  }

  if (!lastTunnel) {
    scheduleBackgroundTunnel();
    return { ok: true, tunnelUrl: null, subdomainHonored: false };
  }

  const subdomainHonored = !subdomain || lastTunnel.url.includes(subdomain);
  if (!subdomainHonored) {
    lastTunnel.close();
    return { ok: true, tunnelUrl: null, subdomainHonored: false };
  }

  tunnel = lastTunnel;
  tunnel.on('close', () => {
    log('main', 'tunnel closed');
    tunnel = null;
    updateTrayMenu();
    if (wss && currentSubdomain) scheduleTunnelReacquire();
  });
  tunnel.on('error', (err) => log('main', `tunnel error: ${err.message}`));
  updateTrayMenu();
  return { ok: true, tunnelUrl: tunnel.url, subdomainHonored: true };
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('read-state', () => {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { return null; }
});

ipcMain.handle('write-state', (_, data) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    updateTrayMenu();
    return true;
  } catch (err) {
    console.error('[main] write-state error:', err.message);
    return false;
  }
});

ipcMain.handle('delete-state', () => {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    updateTrayMenu();
    return true;
  } catch (err) {
    console.error('[main] delete-state error:', err.message);
    return false;
  }
});

ipcMain.handle('start-server', async (_, port = 4993, subdomain = null, maxAttempts = 5) => {
  // Serialize concurrent calls — prevents two renderers from racing the WS server startup.
  if (startServerInFlight) await startServerInFlight;
  let resolveFlight;
  startServerInFlight = new Promise(r => { resolveFlight = r; });
  try {
    return await handleStartServer(port, subdomain, maxAttempts);
  } finally {
    startServerInFlight = null;
    resolveFlight();
  }
});

ipcMain.handle('stop-server', () => {
  if (bgTunnelTimer)  { clearTimeout(bgTunnelTimer);  bgTunnelTimer = null; }
  if (reacquireTimer) { clearTimeout(reacquireTimer); reacquireTimer = null; }
  currentSubdomain = null;
  if (tunnel) { tunnel.close(); tunnel = null; }
  if (wss)    { wss.close();    wss = null; }
  return true;
});

ipcMain.handle('is-tunnel-ready', () => !!tunnel);

ipcMain.handle('get-local-ip', () => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
});

ipcMain.handle('resize-widget', (_, height) => {
  if (widgetWindow) widgetWindow.setSize(172, Math.max(200, Math.ceil(height)));
});

ipcMain.handle('open-widget', () => {
  openWidgetWindow();
  if (setupWindow) {
    const win = setupWindow; setupWindow = null;
    setImmediate(() => win.close());
  }
});

ipcMain.handle('open-setup', () => {
  openSetupWindow();
  destroyTray();
  if (widgetWindow) {
    const win = widgetWindow; widgetWindow = null;
    setImmediate(() => win.close());
  }
});

ipcMain.handle('get-deep-link', () => {
  const link = pendingDeepLink; pendingDeepLink = null; return link;
});

ipcMain.handle('update-tray', updateTrayMenu);

ipcMain.handle('get-update-state', () => updateState);
ipcMain.handle('install-update', () => { autoUpdater.quitAndInstall(); });

ipcMain.handle('get-login-item', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-login-item', (_, enable) => {
  app.setLoginItemSettings({ openAtLogin: enable });
  updateTrayMenu();
});

// Renderer sends log lines here; they land in the same nearby.log file
ipcMain.handle('log', (_, ctx, msg) => { log(ctx, msg); });

// ─── Window factories ─────────────────────────────────────────────────────────

function openSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 420, height: 520,
    resizable: false, frame: true,
    title: 'Nearby — Setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (IS_DEV) { setupWindow.loadURL('http://localhost:3000'); setupWindow.webContents.openDevTools(); }
  else setupWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

function openWidgetWindow() {
  if (widgetWindow) return;
  widgetWindow = new BrowserWindow({
    width: 172, height: 420,
    alwaysOnTop: true, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, title: 'Nearby',
    show: false, // prevent transparent-blank flash before content is ready
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (IS_DEV) widgetWindow.loadURL('http://localhost:3000');
  else widgetWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));

  widgetWindow.on('ready-to-show', () => {
    widgetWindow.show();
    createTray();
  });
  widgetWindow.on('show', updateTrayMenu);
  widgetWindow.on('hide', updateTrayMenu);
  widgetWindow.on('closed', () => {
    widgetWindow = null;
    destroyTray();
    if (tunnel) { tunnel.close(); tunnel = null; }
    closeServer(); // force-terminate all clients for fast port release
  });
}

// ─── Deep-link registration ───────────────────────────────────────────────────

app.setAsDefaultProtocolClient('nearby');

app.on('open-url', (event, url) => {
  event.preventDefault();
  pendingDeepLink = url;
  const target = widgetWindow || setupWindow;
  if (target) target.webContents.send('deep-link', url);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    const url = argv.find((a) => a.startsWith('nearby://'));
    if (url) {
      pendingDeepLink = url;
      const target = widgetWindow || setupWindow;
      if (target) { if (target.isMinimized()) target.restore(); target.focus(); target.webContents.send('deep-link', url); }
    }
  });
}

// ─── Application menu bar (File / Edit / View / Window / Help) ───────────────

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    // macOS-only app menu (first menu = app name)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' },
        ]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'View Log',
          click() { shell.openPath(LOG_FILE); },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          enabled: !IS_DEV,
          click() {
            if (IS_DEV) return;
            autoUpdater.checkForUpdates().catch((err) => log('updater', `Menu check failed: ${err.message}`));
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Auto-updater ─────────────────────────────────────────────────────────────

function sendUpdateStateToRenderer() {
  const win = widgetWindow || setupWindow;
  if (win && !win.isDestroyed()) win.webContents.send('update-state-changed', updateState);
}

function setupAutoUpdater() {
  if (IS_DEV) return; // updater only works in packaged builds

  autoUpdater.autoDownload    = true;  // download silently in background
  autoUpdater.autoInstallOnAppQuit = true; // install on quit if user dismisses the in-app button

  autoUpdater.on('checking-for-update', () => {
    log('updater', 'Checking for update…');
    updateState = 'checking';
    updateTrayMenu();
    sendUpdateStateToRenderer();
  });

  autoUpdater.on('update-available', (info) => {
    log('updater', `Update available: ${info.version}`);
    updateState = 'downloading';
    updateTrayMenu();
    sendUpdateStateToRenderer();
  });

  autoUpdater.on('update-not-available', () => {
    log('updater', 'App is up to date.');
    updateState = 'idle';
    updateTrayMenu();
    sendUpdateStateToRenderer();
  });

  autoUpdater.on('download-progress', (progress) => {
    log('updater', `Downloading… ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('updater', `Update downloaded: ${info.version}`);
    updateState = 'ready';
    updateTrayMenu();
    sendUpdateStateToRenderer();
  });

  autoUpdater.on('error', (err) => {
    log('updater', `Update error: ${err.message}`);
    updateState = 'idle';
    updateTrayMenu();
    sendUpdateStateToRenderer();
  });

  // Silent check 10 s after startup so it doesn't compete with tunnel setup.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log('updater', `Check failed: ${err.message}`));
  }, 10_000);
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Localtunnel serves a challenge page unless this header is present.
  // We can't set custom headers on the WebSocket API, so we intercept all
  // outgoing requests here in the main process and inject the header for any
  // request destined for loca.lt — works for both the initial HTTP upgrade and
  // any follow-up requests.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.includes('.loca.lt')) {
      details.requestHeaders['bypass-tunnel-reminder'] = 'true';
      log('bypass', `injected bypass header → ${details.url}`);
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  buildAppMenu();
  setupAutoUpdater();

  const networkOk = await checkNetworkAccess();
  if (!networkOk) return;

  const hasState = fs.existsSync(STATE_FILE);
  if (hasState) openWidgetWindow();
  else openSetupWindow();

  app.on('activate', () => {
    if (!setupWindow && !widgetWindow) {
      if (fs.existsSync(STATE_FILE)) openWidgetWindow();
      else openSetupWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  destroyTray();
  if (bgTunnelTimer)  { clearTimeout(bgTunnelTimer);  bgTunnelTimer = null; }
  if (reacquireTimer) { clearTimeout(reacquireTimer); reacquireTimer = null; }
  currentSubdomain = null;
  if (tunnel) { tunnel.close(); tunnel = null; }
  closeServer(); // force-terminate all clients for fast port release
});
