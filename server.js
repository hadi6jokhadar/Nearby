// server.js — Embedded WebSocket server (runs in Host's Electron main process)

const { WebSocketServer } = require('ws');
const { log } = require('./logger');

const COLORS = [
  '#7F77DD', '#1D9E75', '#D85A30', '#D4537E',
  '#378ADD', '#639922', '#BA7517', '#E24B4A', '#888780',
];

const channels = new Map();

function getOrCreateChannel(channelId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, { usedColors: [], clients: new Map() });
  }
  return channels.get(channelId);
}

function assignColor(channel) {
  for (const color of COLORS) {
    if (!channel.usedColors.includes(color)) return color;
  }
  return COLORS[channel.clients.size % COLORS.length];
}

function broadcast(channel, message, excludeUserId = null) {
  const raw = JSON.stringify(message);
  for (const [userId, ws] of channel.clients) {
    if (userId !== excludeUserId && ws.readyState === 1) ws.send(raw);
  }
}

function sendTo(channel, targetUserId, message) {
  const ws = channel.clients.get(targetUserId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

function startServer(port = 4993) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port });

    function onError(err) {
      wss.removeListener('listening', onListening);
      reject(err);
    }

    function onListening() {
      wss.removeListener('error', onError);
      wss.on('error', (err) => log('server', `WSS error: ${err.message}`));
      log('server', `listening on port ${port}`);

      wss.on('connection', (ws, req) => {
        const remoteAddr = req.socket.remoteAddress;
        log('server', `new TCP connection from ${remoteAddr}`);

        let connUserId    = null;
        let connChannelId = null;

        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }

          const { type, channelId, userId } = msg;
          if (!type || !channelId || !userId) return;

          const channel = getOrCreateChannel(channelId);

          switch (type) {
            case 'HELLO': {
              connUserId    = userId;
              connChannelId = channelId;
              channel.clients.set(userId, ws);
              const color = assignColor(channel);
              channel.usedColors.push(color);
              log('server', `HELLO  userId=${userId.slice(0,8)} name=${msg.name} channel=${channelId.slice(0,8)} → color=${color} peers=${channel.clients.size}`);

              ws.send(JSON.stringify({ type: 'COLOR_ASSIGN', color, channelId }));
              broadcast(channel, { type: 'PEER_JOINED', userId, name: msg.name, channelId }, userId);
              break;
            }
            case 'STATE_RESPONSE':
              log('server', `STATE_RESPONSE from ${userId.slice(0,8)} → ${msg.targetUserId?.slice(0,8)}`);
              sendTo(channel, msg.targetUserId, msg);
              break;
            case 'PING':
              broadcast(channel, msg, userId);
              break;
            case 'UPDATE':
            case 'PAIR':
              log('server', `${type} from ${userId.slice(0,8)}`);
              broadcast(channel, msg, userId);
              break;
            case 'RESET':
              log('server', `RESET from ${userId.slice(0,8)}`);
              broadcast(channel, { type: 'RESET', channelId, userId });
              channels.delete(channelId);
              break;
            case 'SYNC_CHECK':
              broadcast(channel, msg, userId);
              break;
            case 'REQUEST_SYNC':
              sendTo(channel, msg.targetUserId, msg);
              break;
            case 'RELATIONSHIP_UPDATE':
              log('server', `RELATIONSHIP_UPDATE from ${userId.slice(0,8)}`);
              broadcast(channel, msg, userId);
              break;
            default:
              break;
          }
        });

        ws.on('close', (code, reason) => {
          log('server', `connection closed: userId=${connUserId?.slice(0,8) ?? 'unknown'} code=${code} reason=${reason?.toString() || ''}`);
          if (!connUserId || !connChannelId) return;
          const channel = channels.get(connChannelId);
          if (!channel) return;
          if (channel.clients.has(connUserId)) {
            channel.clients.delete(connUserId);
            if (channel.usedColors.length > channel.clients.size) channel.usedColors.pop();
          }
          broadcast(channel, { type: 'PEER_OFFLINE', userId: connUserId, channelId: connChannelId });
          if (channel.clients.size === 0) channels.delete(connChannelId);
        });

        ws.on('error', (err) => {
          log('server', `socket error: ${err.message}`);
        });
      });

      resolve(wss);
    }

    wss.once('error', onError);
    wss.once('listening', onListening);
  });
}

module.exports = { startServer };
