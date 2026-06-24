// preload.js — Electron contextBridge
// Exposes a safe, narrow API surface to the renderer process.
// No Node.js or Electron internals are accessible beyond these methods.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Local state persistence
  readState:    ()       => ipcRenderer.invoke('read-state'),
  writeState:   (data)   => ipcRenderer.invoke('write-state', data),
  deleteState:  ()       => ipcRenderer.invoke('delete-state'),

  // Embedded WS server control (any member can start/stop)
  startServer:  (port, subdomain, maxAttempts) => ipcRenderer.invoke('start-server', port, subdomain, maxAttempts),
  stopServer:   ()       => ipcRenderer.invoke('stop-server'),

  // Fired when the main relay permanently loses the subdomain to another member.
  // The renderer should switch to guest mode and reconnect.
  onRelayDemoted:  (cb) => { const fn = () => cb(); ipcRenderer.on('relay-demoted', fn); return fn; },
  offRelayDemoted: (fn) => ipcRenderer.removeListener('relay-demoted', fn),

  // Fired by the background retry in the main process when the public tunnel
  // is finally established after a startup failure.
  isTunnelReady:  ()     => ipcRenderer.invoke('is-tunnel-ready'),
  onTunnelReady:  (cb)   => { const fn = (_, url) => cb(url); ipcRenderer.on('tunnel-ready', fn); return fn; },
  offTunnelReady: (fn)   => ipcRenderer.removeListener('tunnel-ready', fn),

  // Network
  getLocalIP:   ()       => ipcRenderer.invoke('get-local-ip'),

  // Window management
  resizeWidget: (height) => ipcRenderer.invoke('resize-widget', height),
  openWidget:   ()       => ipcRenderer.invoke('open-widget'),
  openSetup:    ()       => ipcRenderer.invoke('open-setup'),

  // Deep-link: ask for any pending link captured before the renderer loaded
  getDeepLink:  ()       => ipcRenderer.invoke('get-deep-link'),

  // Deep-link: subscribe to links that arrive while the app is running.
  // Returns the bound listener so the caller can pass it to offDeepLink.
  onDeepLink:  (cb) => { const fn = (_, url) => cb(url); ipcRenderer.on('deep-link', fn); return fn; },
  offDeepLink: (fn) => ipcRenderer.removeListener('deep-link', fn),

  // Tray actions dispatched from the main process (reset, copy-link)
  onTrayAction: (cb)     => ipcRenderer.on('tray-action', (_, action) => cb(action)),

  // Let the renderer tell the main process to refresh the tray menu labels
  updateTray:   ()       => ipcRenderer.invoke('update-tray'),

  // IPC-based window drag (renderer calls these instead of -webkit-app-region: drag)
  windowDragStart: (x, y) => ipcRenderer.send('window-drag-start', x, y),
  windowDragMove:  (x, y) => ipcRenderer.send('window-drag-move',  x, y),
  windowDragEnd:   ()     => ipcRenderer.send('window-drag-end'),

  // Widget view mode: 'normal' | 'compact'
  getWidgetMode:        ()       => ipcRenderer.invoke('get-widget-mode'),
  onWidgetModeChanged:  (cb)     => { const fn = (_, mode) => cb(mode); ipcRenderer.on('widget-mode-changed', fn); return fn; },
  offWidgetModeChanged: (fn)     => ipcRenderer.removeListener('widget-mode-changed', fn),

  // Launch at system startup
  getLoginItem: ()         => ipcRenderer.invoke('get-login-item'),
  setLoginItem: (enable)   => ipcRenderer.invoke('set-login-item', enable),

  // Write a log line into the main-process nearby.log file
  log: (ctx, msg)        => ipcRenderer.invoke('log', ctx, msg),

  // In-app update button
  getUpdateState:    ()     => ipcRenderer.invoke('get-update-state'),
  installUpdate:     ()     => ipcRenderer.invoke('install-update'),
  onUpdateState:     (cb)   => { const fn = (_, state) => cb(state); ipcRenderer.on('update-state-changed', fn); return fn; },
  offUpdateState:    (fn)   => ipcRenderer.removeListener('update-state-changed', fn),
});
