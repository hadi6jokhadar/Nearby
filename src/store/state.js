// state.js — lightweight shared state module (no Redux, no Context API overhead).
// Components import { getState, setState, subscribe } and interact synchronously.
// React components subscribe to changes and re-render when notified.

let _state = {
  // Loaded from state.json on app start; null until hydrated
  self: null,          // { userId, name, color, channelId, teamName, role, hostIP, port }
  peers: [],           // [{ userId, name, color, updatedAt, pairedWith, lastSeen, online }]
  relationships: [],   // [{ id, userA, userB, state, updatedAt, updatedBy }]
  view: 'loading',     // 'loading' | 'setup' | 'widget'
  connected: false,    // WS connection status
};

const listeners = new Set();

export function getState() {
  return _state;
}

export function setState(patch) {
  _state = { ..._state, ...patch };
  listeners.forEach((fn) => fn(_state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn); // returns unsubscribe
}

// ─── Peer helpers ─────────────────────────────────────────────────────────────

export function upsertPeer(incoming) {
  const peers = [..._state.peers];
  const idx = peers.findIndex((p) => p.userId === incoming.userId);

  if (idx === -1) {
    peers.push({ online: true, lastSeen: Date.now(), ...incoming });
  } else {
    const stored = peers[idx];
    // Only update if the incoming record is newer (conflict resolution)
    if (!incoming.updatedAt || !stored.updatedAt || incoming.updatedAt >= stored.updatedAt) {
      peers[idx] = { ...stored, ...incoming };
    }
  }

  setState({ peers });
}

export function setPeerOnline(userId, online) {
  const peers = _state.peers.map((p) =>
    p.userId === userId ? { ...p, online, lastSeen: online ? Date.now() : p.lastSeen } : p
  );
  setState({ peers });
}

export function touchPeerLastSeen(userId) {
  const peers = _state.peers.map((p) =>
    p.userId === userId ? { ...p, lastSeen: Date.now(), online: true } : p
  );
  setState({ peers });
}

// ─── Relationship helpers ─────────────────────────────────────────────────────

export function upsertRelationship(incoming) {
  const relationships = [...(_state.relationships || [])];
  const idx = relationships.findIndex((r) => r.id === incoming.id);

  if (idx === -1) {
    relationships.push(incoming);
  } else {
    const stored = relationships[idx];
    if (!incoming.updatedAt || !stored.updatedAt || incoming.updatedAt >= stored.updatedAt) {
      relationships[idx] = { ...stored, ...incoming };
    }
  }

  setState({ relationships });
}
