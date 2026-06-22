// useWebSocket.js — manages the WebSocket connection lifecycle.
// Handles: connect, reconnect (every 5s), message dispatch, PING heartbeat,
// and the full HELLO → COLOR_ASSIGN → STATE_RESPONSE handshake.

import { useEffect, useRef, useCallback } from 'react';
import {
  getState,
  setState,
  upsertPeer,
  upsertRelationship,
  setPeerOnline,
  touchPeerLastSeen,
} from '../store/state.js';

function getMaxUpdatedAt(state) {
  return Math.max(
    0,
    ...(state.peers || []).map((p) => p.updatedAt || 0),
    ...(state.relationships || []).map((r) => r.updatedAt || 0),
    state.self?.updatedAt || 0,
  );
}

const PING_INTERVAL_MS = 5_000;
const RECONNECT_INTERVAL_MS = 5_000;
const PRESENCE_TIMEOUT_MS = 15_000;
const PRESENCE_CHECK_MS = 3_000;

function channelSubdomain(channelId) {
  return 'nearby-' + channelId.replace(/-/g, '').slice(0, 12);
}

export function useWebSocket({ onReset } = {}) {
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const connectTimeoutRef = useRef(null);
  const pingTimerRef = useRef(null);
  const presenceTimerRef = useRef(null);
  const syncTimerRef = useRef(null);
  const isAttemptingTakeover = useRef(false);
  const hostFailCountRef  = useRef(0); // consecutive failed connects as host
  const guestFailCountRef = useRef(0); // consecutive failed connects as guest

  // ── Helpers ──────────────────────────────────────────────────────────────

  const rlog = (msg) => window.electronAPI?.log?.('ws', msg);

  const send = useCallback((msg) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // ── Message handler ───────────────────────────────────────────────────────

  const handleMessage = useCallback((raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type } = msg;
    const { self, peers } = getState();

    rlog(`MSG ${type}`);

    switch (type) {
      case 'COLOR_ASSIGN': {
        rlog(`COLOR_ASSIGN → color=${msg.color}`);
        const updated = { ...self, color: msg.color };
        setState({ self: updated });
        const st0 = getState();
        window.electronAPI.writeState({ self: updated, peers: st0.peers, relationships: st0.relationships || [] });
        break;
      }

      case 'PEER_JOINED': {
        rlog(`PEER_JOINED name=${msg.name} userId=${msg.userId?.slice(0,8)}`);
        upsertPeer({
          userId: msg.userId,
          name: msg.name,
          color: null,        // will be filled by their STATE_RESPONSE
          updatedAt: Date.now(),
          pairedWith: null,
          online: true,
          lastSeen: Date.now(),
        });

        const currentSt = getState();
        const statePayload = {
          type: 'STATE_RESPONSE',
          channelId: self.channelId,
          userId: self.userId,
          targetUserId: msg.userId,
          peers: [
            {
              userId: self.userId,
              name: self.name,
              color: self.color,
              updatedAt: Date.now(),
              pairedWith: self.pairedWith || null,
            },
            ...currentSt.peers.map(({ userId, name, color, updatedAt, pairedWith }) => ({
              userId, name, color, updatedAt, pairedWith: pairedWith || null,
            })),
          ],
          relationships: currentSt.relationships || [],
        };
        rlog(`sending STATE_RESPONSE to ${msg.userId?.slice(0,8)} peers=${statePayload.peers.length}`);
        send(statePayload);
        break;
      }

      case 'STATE_RESPONSE': {
        rlog(`STATE_RESPONSE received peers=${msg.peers?.length ?? 0} relationships=${msg.relationships?.length ?? 0}`);
        if (msg.peers) {
          for (const peer of msg.peers) {
            if (peer.userId !== self.userId) {
              rlog(`  hydrating peer name=${peer.name} userId=${peer.userId?.slice(0,8)}`);
              upsertPeer({ ...peer, online: true, lastSeen: Date.now() });
            }
          }
        }
        if (msg.relationships) {
          for (const rel of msg.relationships) {
            upsertRelationship(rel);
          }
        }
        break;
      }

      case 'UPDATE': {
        if (msg.userId !== self.userId) {
          rlog(`UPDATE from ${msg.userId?.slice(0,8)} name=${msg.name}`);
          upsertPeer({
            userId: msg.userId,
            name: msg.name,
            updatedAt: msg.updatedAt,
          });
        }
        break;
      }

      case 'PING': {
        if (msg.userId !== self.userId) {
          touchPeerLastSeen(msg.userId);
        }
        break;
      }

      case 'PAIR': {
        if (msg.userId !== self.userId) {
          rlog(`PAIR from ${msg.userId?.slice(0,8)} pairedWith=${msg.pairedWith?.slice(0,8) ?? 'null'}`);
          upsertPeer({
            userId: msg.userId,
            pairedWith: msg.pairedWith,
            updatedAt: Date.now(),
          });
        }
        break;
      }

      case 'PEER_OFFLINE': {
        rlog(`PEER_OFFLINE userId=${msg.userId?.slice(0,8)}`);
        setPeerOnline(msg.userId, false);
        break;
      }

      case 'RESET': {
        rlog('RESET received — wiping state and opening setup');
        window.electronAPI.deleteState().then(() => {
          window.electronAPI.openSetup();
        });
        break;
      }

      case 'SYNC_CHECK': {
        if (msg.userId === self?.userId) break;
        const myVersion = getMaxUpdatedAt(getState());
        if (msg.dataVersion > myVersion) {
          rlog(`SYNC_CHECK from ${msg.userId?.slice(0,8)} — they have newer data (${msg.dataVersion} > ${myVersion}), requesting sync`);
          send({
            type: 'REQUEST_SYNC',
            channelId: self.channelId,
            userId: self.userId,
            fromUserId: self.userId,
            targetUserId: msg.userId,
          });
        }
        break;
      }

      case 'REQUEST_SYNC': {
        if (msg.targetUserId !== self?.userId) break;
        rlog(`REQUEST_SYNC from ${msg.fromUserId?.slice(0,8)} — sending full STATE_RESPONSE`);
        const syncSt = getState();
        const syncPayload = {
          type: 'STATE_RESPONSE',
          channelId: syncSt.self.channelId,
          userId: syncSt.self.userId,
          targetUserId: msg.fromUserId,
          peers: [
            {
              userId: syncSt.self.userId,
              name: syncSt.self.name,
              color: syncSt.self.color,
              updatedAt: syncSt.self.updatedAt || 0,
              pairedWith: syncSt.self.pairedWith || null,
            },
            ...syncSt.peers.map(({ userId, name, color, updatedAt, pairedWith }) => ({
              userId, name, color, updatedAt: updatedAt || 0, pairedWith: pairedWith || null,
            })),
          ],
          relationships: syncSt.relationships || [],
        };
        send(syncPayload);
        break;
      }

      case 'RELATIONSHIP_UPDATE': {
        rlog(`RELATIONSHIP_UPDATE id=${msg.relationship?.id}`);
        if (msg.relationship) {
          upsertRelationship(msg.relationship);
          const relSt = getState();
          window.electronAPI.writeState({ self: relSt.self, peers: relSt.peers, relationships: relSt.relationships || [] });
        }
        break;
      }

      default:
        rlog(`UNKNOWN message type: ${type}`);
        break;
    }
  }, [send, onReset]);

  // ── Presence checker ─────────────────────────────────────────────────────

  const startPresenceCheck = useCallback(() => {
    clearInterval(presenceTimerRef.current);
    presenceTimerRef.current = setInterval(() => {
      const { peers } = getState();
      const now = Date.now();
      const updated = peers.map((p) => ({
        ...p,
        online: p.online && now - (p.lastSeen || 0) < PRESENCE_TIMEOUT_MS,
      }));
      setState({ peers: updated });
    }, PRESENCE_CHECK_MS);
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connect = useCallback(() => {
    const { self } = getState();
    if (!self) { rlog('connect() called but self is null — skipping'); return; }

    // Close any open or connecting socket before starting fresh.
    // Prevents duplicate HELLO registrations (e.g. from React StrictMode double-invoke)
    // that cause the server to route STATE_RESPONSE to a stale connection.
    if (wsRef.current) {
      const st = wsRef.current.readyState;
      if (st === WebSocket.CONNECTING || st === WebSocket.OPEN) {
        wsRef.current.onclose = null; // prevent reconnect trigger
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    const url = self.role === 'host'
      ? `ws://localhost:${self.port}`
      : self.wsUrl;

    rlog(`connecting to ${url} (role=${self.role})`);

    if (!url) { rlog('ERROR: url is empty/null — cannot connect'); return; }

    clearTimeout(connectTimeoutRef.current);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    // loca.lt can silently stall a WebSocket upgrade for 10+ seconds before
    // returning 1006. This 8s hard timeout aborts the stalled socket and
    // immediately triggers the onclose → takeover / reconnect path so the
    // guestUnreachable banner appears quickly and the next attempt starts sooner.
    connectTimeoutRef.current = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        rlog('connect timeout (8s) — aborting stalled connection');
        ws.close();
      }
    }, 8_000);

    ws.onopen = () => {
      clearTimeout(connectTimeoutRef.current);
      rlog(`connected OK to ${url}`);
      isAttemptingTakeover.current = false;
      hostFailCountRef.current  = 0;
      guestFailCountRef.current = 0;
      setState({ connected: true, guestUnreachable: false });
      clearTimeout(reconnectTimerRef.current);

      // For guests: persist the URL that actually worked so future restarts use it
      const stOnOpen = getState();
      if (stOnOpen.self?.role === 'guest' && url !== stOnOpen.self?.wsUrl) {
        const updatedSelf = { ...stOnOpen.self, wsUrl: url };
        setState({ self: updatedSelf });
        window.electronAPI.writeState({ self: updatedSelf, peers: stOnOpen.peers, relationships: stOnOpen.relationships || [] });
        rlog(`guest wsUrl persisted → ${url}`);
      }

      ws.send(JSON.stringify({
        type: 'HELLO',
        channelId: self.channelId,
        userId: self.userId,
        name: self.name,
      }));
      rlog(`sent HELLO name=${self.name} channel=${self.channelId?.slice(0,8)}`);

      clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        send({
          type: 'PING',
          channelId: self.channelId,
          userId: self.userId,
        });
      }, PING_INTERVAL_MS);

      clearInterval(syncTimerRef.current);
      syncTimerRef.current = setInterval(() => {
        const st = getState();
        if (!st.self) return;
        send({
          type: 'SYNC_CHECK',
          channelId: st.self.channelId,
          userId: st.self.userId,
          dataVersion: getMaxUpdatedAt(st),
        });
      }, 5_000);

      startPresenceCheck();
    };

    ws.onmessage = (e) => handleMessage(e.data);

    ws.onclose = (evt) => {
      rlog(`disconnected: code=${evt.code} reason="${evt.reason}" wasClean=${evt.wasClean}`);
      setState({ connected: false });
      clearInterval(pingTimerRef.current);
      clearInterval(syncTimerRef.current);
      const stOnClose = getState();

      if (stOnClose.self?.role === 'guest' && !isAttemptingTakeover.current) {
        // Race for the relay immediately on disconnect. No waiting for multiple failures —
        // if the relay is only briefly blipping the takeover fails fast (subdomain still
        // held by the live relay) and we fall back to a normal 5 s reconnect. All guests
        // compete simultaneously; the first to win the subdomain becomes the new relay.
        guestFailCountRef.current += 1;
        // Only show the "relay offline" banner after 2 consecutive failures so brief
        // network blips don't produce a jarring flash.
        if (guestFailCountRef.current >= 2) setState({ guestUnreachable: true });
        isAttemptingTakeover.current = true;
        const selfSnap = stOnClose.self;
        const subdomain = channelSubdomain(selfSnap.channelId);
        rlog(`relay disconnected — immediate takeover attempt (subdomain=${subdomain})`);

        window.electronAPI.startServer(selfSnap.port || 4993, subdomain, 1).then((result) => {
          isAttemptingTakeover.current = false;
          if (result.ok && result.tunnelUrl && result.subdomainHonored) {
            const wsUrl = result.tunnelUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
            rlog(`relay takeover succeeded → ${wsUrl}`);
            const cur = getState();
            const updatedSelf = { ...cur.self, role: 'host', wsUrl, port: selfSnap.port || 4993 };
            setState({ self: updatedSelf, guestUnreachable: false });
            window.electronAPI.writeState({ self: updatedSelf, peers: cur.peers, relationships: cur.relationships || [] });
            clearTimeout(reconnectTimerRef.current);
            connect();
          } else {
            rlog(`takeover failed (subdomainHonored=${result.subdomainHonored}) — reconnecting as guest; will retry on next disconnect`);
            reconnectTimerRef.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
          }
        }).catch((err) => {
          isAttemptingTakeover.current = false;
          rlog(`relay takeover error: ${err.message}`);
          reconnectTimerRef.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
        });
        return; // wait for takeover result before scheduling any reconnect
      }

      // Host path: after 5 consecutive failures (~25 s) the local WS server is
      // presumed broken (e.g. zombie port from a previous crash). Stop it, rebind,
      // then reconnect. On failure, demote to guest on the deterministic URL so the
      // existing relay (if any) can be reached through the tunnel.
      if (stOnClose.self?.role === 'host') {
        hostFailCountRef.current += 1;
        if (hostFailCountRef.current >= 5 && !isAttemptingTakeover.current) {
          hostFailCountRef.current = 0;
          isAttemptingTakeover.current = true;
          const selfSnap = stOnClose.self;
          const subdomain = channelSubdomain(selfSnap.channelId);
          rlog(`host WS failed 5× — restarting relay server (subdomain=${subdomain})`);
          window.electronAPI.stopServer()
            .then(() => new Promise(r => setTimeout(r, 500))) // let graceful close release the port
            .then(() => window.electronAPI.startServer(selfSnap.port || 4993, subdomain, 1))
            .then((result) => {
              isAttemptingTakeover.current = false;
              if (result.ok && result.tunnelUrl && result.subdomainHonored) {
                const wsUrl = result.tunnelUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
                rlog(`relay restarted → ${wsUrl}`);
                const cur = getState();
                if (cur.self?.wsUrl !== wsUrl) {
                  const updatedSelf = { ...cur.self, wsUrl };
                  setState({ self: updatedSelf });
                  window.electronAPI.writeState({ self: updatedSelf, peers: cur.peers, relationships: cur.relationships || [] });
                }
              } else if (!result.ok) {
                rlog('relay restart failed — switching to guest on deterministicUrl');
                const cur = getState();
                const wsUrl = `wss://${subdomain}.loca.lt`;
                const updatedSelf = { ...cur.self, role: 'guest', wsUrl };
                setState({ self: updatedSelf, guestUnreachable: false });
                window.electronAPI.writeState({ self: updatedSelf, peers: cur.peers, relationships: cur.relationships || [] });
              }
              reconnectTimerRef.current = setTimeout(connect, 500);
            })
            .catch((err) => {
              isAttemptingTakeover.current = false;
              rlog(`relay restart error: ${err.message}`);
              reconnectTimerRef.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
            });
          return;
        }
      }

      reconnectTimerRef.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
    };

    ws.onerror = (evt) => {
      // evt.message is only available in Node-WS; browser WS gives an opaque Event
      rlog(`onerror fired (type=${evt.type}) — close will follow`);
      ws.close();
    };
  }, [send, handleMessage, startPresenceCheck]);

  // ── Public actions ────────────────────────────────────────────────────────

  const sendPair = useCallback((pairedWith) => {
    const { self } = getState();
    if (!self) return;
    send({
      type: 'PAIR',
      channelId: self.channelId,
      userId: self.userId,
      pairedWith,
    });
    // Optimistically update self
    const updated = { ...self, pairedWith };
    setState({ self: updated });
    const pairSt = getState();
    window.electronAPI.writeState({ self: updated, peers: pairSt.peers, relationships: pairSt.relationships || [] });
  }, [send]);

  const sendUpdate = useCallback((name) => {
    const { self } = getState();
    if (!self) return;
    const updatedAt = Date.now();
    send({
      type: 'UPDATE',
      channelId: self.channelId,
      userId: self.userId,
      name,
      updatedAt,
    });
    const updated = { ...self, name, updatedAt };
    setState({ self: updated });
    const updSt = getState();
    window.electronAPI.writeState({ self: updated, peers: updSt.peers, relationships: updSt.relationships || [] });
  }, [send]);

  const sendReset = useCallback(() => {
    const { self } = getState();
    if (!self || self.role !== 'host') return;
    send({
      type: 'RESET',
      channelId: self.channelId,
      userId: self.userId,
    });
  }, [send]);

  const sendRelationshipUpdate = useCallback((relationship) => {
    const { self } = getState();
    if (!self) return;
    send({
      type: 'RELATIONSHIP_UPDATE',
      channelId: self.channelId,
      userId: self.userId,
      relationship,
    });
    upsertRelationship(relationship);
    const relSt = getState();
    window.electronAPI.writeState({ self: relSt.self, peers: relSt.peers, relationships: relSt.relationships || [] });
  }, [send]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimerRef.current);
      clearInterval(pingTimerRef.current);
      clearInterval(presenceTimerRef.current);
      clearInterval(syncTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional unmount
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Subscribe to relay-demoted: the main process shut down the local relay because
  // another member permanently reclaimed the tunnel subdomain. Switch to guest mode
  // and reconnect immediately so we reach the new relay through the tunnel.
  useEffect(() => {
    const fn = window.electronAPI.onRelayDemoted(() => {
      const st = getState();
      if (!st.self) return;
      const subdomain = channelSubdomain(st.self.channelId);
      const wsUrl = `wss://${subdomain}.loca.lt`;
      const updatedSelf = { ...st.self, role: 'guest', wsUrl };
      rlog('relay-demoted received — switching to guest, reconnecting…');
      setState({ self: updatedSelf, guestUnreachable: false });
      window.electronAPI.writeState({ self: updatedSelf, peers: st.peers, relationships: st.relationships || [] });
      clearTimeout(reconnectTimerRef.current);
      connect();
    });
    return () => window.electronAPI.offRelayDemoted(fn);
  }, [connect]);

  const reconnect = useCallback((newSelf) => {
    if (newSelf) setState({ self: newSelf });
    setState({ guestUnreachable: false });
    clearTimeout(reconnectTimerRef.current);
    connect();
  }, [connect]);

  return { send, sendPair, sendUpdate, sendReset, sendRelationshipUpdate, reconnect };
}
