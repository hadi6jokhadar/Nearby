// WidgetView.jsx — Floating always-on-top widget.
// Peers with active relationships appear side-by-side in pair cards.
// Solo peers (no active relationship) are listed individually below.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import PeerCircle from '../components/PeerCircle.jsx';
import { getState, subscribe } from '../store/state.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

function getRelationship(selfId, peerId, relationships) {
  const id = [selfId, peerId].sort().join('-');
  return (relationships || []).find((r) => r.id === id) || null;
}

function parseDeepLink(url) {
  try {
    if (!url.startsWith('nearby://join/')) return null;
    const payload = url.slice('nearby://join/'.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(payload + '=='.slice(0, (4 - payload.length % 4) % 4));
    const { ws, channelId } = JSON.parse(json);
    if (!ws || !channelId) return null;
    return { wsUrl: ws, channelId };
  } catch { return null; }
}

function channelSubdomain(channelId) {
  return 'nearby-' + channelId.replace(/-/g, '').slice(0, 12);
}

function buildInviteLink(self) {
  if (!self?.channelId || !self?.wsUrl) return null;
  try {
    // Use the stored wsUrl: local IP when tunnel is down (LAN only),
    // loca.lt URL when tunnel is established (works from anywhere).
    const payload = btoa(JSON.stringify({ ws: self.wsUrl, channelId: self.channelId }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `nearby://join/${payload}`;
  } catch { return null; }
}

export default function WidgetView({ onReset }) {
  const [appState, setAppState] = useState(getState);
  const containerRef = useRef(null);
  const [copyLabel, setCopyLabel] = useState('🔗 Copy link');
  const [activePopover, setActivePopover] = useState(null); // userId
  const [newLink, setNewLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [tunnelReady, setTunnelReady] = useState(false);
  const [updateState, setUpdateState] = useState('idle');
  const [widgetMode, setWidgetMode] = useState('normal');
  const [compactPopover, setCompactPopover] = useState(null); // peerId in compact mode

  // IPC-based window drag: replaces -webkit-app-region: drag so right-click is
  // always a plain Chromium client-area event that reaches webContents 'context-menu'.
  const startWindowDrag = useCallback((e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a')) return;
    window.electronAPI.windowDragStart(e.screenX, e.screenY);
    const onMove = (mv) => window.electronAPI.windowDragMove(mv.screenX, mv.screenY);
    const onEnd  = ()   => {
      window.electronAPI.windowDragEnd();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onEnd);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onEnd);
  }, []);

  useEffect(() => {
    const unsub = subscribe(setAppState);
    return unsub;
  }, []);

  useEffect(() => {
    window.electronAPI.getUpdateState().then(setUpdateState);
    const fn = window.electronAPI.onUpdateState(setUpdateState);
    return () => window.electronAPI.offUpdateState(fn);
  }, []);

  useEffect(() => {
    window.electronAPI.getWidgetMode().then(setWidgetMode);
    const fn = window.electronAPI.onWidgetModeChanged((mode) => {
      setWidgetMode(mode);
      if (mode !== 'compact') setCompactPopover(null);
    });
    return () => window.electronAPI.offWidgetModeChanged(fn);
  }, []);

  // Track public tunnel status and upgrade wsUrl to the public URL when tunnel connects.
  useEffect(() => {
    window.electronAPI.isTunnelReady().then(setTunnelReady);
    const fn = window.electronAPI.onTunnelReady((tunnelUrl) => {
      setTunnelReady(true);
      // Upgrade wsUrl from local IP to public tunnel URL so future invite links are public.
      const wsUrl = tunnelUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
      const st = getState();
      if (!st.self || st.self.wsUrl === wsUrl) return;
      const updatedSelf = { ...st.self, wsUrl };
      setState({ self: updatedSelf });
      window.electronAPI.writeState({ self: updatedSelf, peers: st.peers, relationships: st.relationships || [] });
    });
    return () => window.electronAPI.offTunnelReady(fn);
  }, []);

  const { sendReset, sendRelationshipUpdate, reconnect } = useWebSocket({ onReset });
  const { self, peers, connected, relationships, guestUnreachable } = appState;

  // Resize height to content (both normal and compact modes)
  useEffect(() => {
    if (!containerRef.current) return;
    window.electronAPI.resizeWidget(containerRef.current.scrollHeight + 16);
  });

  async function handleReset() {
    sendReset();
    await window.electronAPI.stopServer();
    await window.electronAPI.deleteState();
    await window.electronAPI.openSetup();
  }

  useEffect(() => {
    window.electronAPI.onTrayAction((action) => {
      if (action === 'reset') handleReset();
    });
  }, []);

  function handlePeerClick(peer) {
    setActivePopover((prev) => prev === peer.userId ? null : peer.userId);
  }

  function handleSetRelationship(peer, state) {
    if (!self) return;
    const [userA, userB] = [self.userId, peer.userId].sort();
    sendRelationshipUpdate({
      id: `${userA}-${userB}`,
      userA, userB, state,
      updatedAt: Date.now(),
      updatedBy: self.userId,
    });
    setActivePopover(null);
  }

  async function handleRelink() {
    const parsed = parseDeepLink(newLink.trim());
    if (!parsed) return setLinkError('Invalid invite link.');
    setLinkError('');
    // Always use the deterministic channel URL — whoever currently holds the relay serves it.
    const subdomain = channelSubdomain(parsed.channelId);
    const wsUrl = parsed.wsUrl.includes('.loca.lt')
      ? `wss://${subdomain}.loca.lt`
      : parsed.wsUrl; // Keep LAN URLs as-is
    const updatedSelf = { ...self, wsUrl, channelId: parsed.channelId };
    const st = getState();
    await window.electronAPI.writeState({ self: updatedSelf, peers: [], relationships: st.relationships || [] });
    setNewLink('');
    reconnect(updatedSelf);
  }

  function handleCopy() {
    const link = buildInviteLink(self);
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
      setCopyLabel('✓ Copied!');
      setTimeout(() => setCopyLabel('🔗 Copy link'), 2000);
    });
  }

  if (!self) return null;

  // ── Shared layout computations (used by both normal and compact renders) ──
  const selfId = self.userId;
  const activeRels = (relationships || []).filter((r) => r.state);

  const selfPairs = activeRels
    .filter((r) => r.userA === selfId || r.userB === selfId)
    .map((r) => ({
      rel: r,
      partner: peers.find((p) => p.userId === (r.userA === selfId ? r.userB : r.userA)),
    }))
    .filter((item) => item.partner);

  const peerPairs = activeRels
    .filter((r) => r.userA !== selfId && r.userB !== selfId)
    .map((r) => ({
      rel: r,
      peerA: peers.find((p) => p.userId === r.userA),
      peerB: peers.find((p) => p.userId === r.userB),
    }))
    .filter((item) => item.peerA && item.peerB);

  const pairedPeerIds = new Set([
    ...selfPairs.map((sp) => sp.partner.userId),
    ...peerPairs.flatMap((pp) => [pp.peerA.userId, pp.peerB.userId]),
  ]);
  const soloPeers = peers
    .filter((p) => !pairedPeerIds.has(p.userId))
    .sort((a, b) => {
      if ((a.online !== false) !== (b.online !== false)) return a.online !== false ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  // ── Compact view ──────────────────────────────────────────────────────────
  if (widgetMode === 'compact') {
    const selfStatus = connected ? 'online' : (guestUnreachable ? 'relay-err' : 'offline');
    const selfInitial = (self.name || '?')[0].toUpperCase();

    const popoverPeer = compactPopover ? peers.find((p) => p.userId === compactPopover) : null;
    const popoverRel  = popoverPeer ? getRelationship(selfId, popoverPeer.userId, relationships) : null;

    // Render a compact orb (32px, no name label)
    function renderCompactOrb(peer, isSelf, status, clickable) {
      const initial = (peer.name || '?')[0].toUpperCase();
      return (
        <div
          key={peer.userId}
          className={`compact-orb ${status}${clickable ? ' clickable' : ''}${compactPopover === peer.userId ? ' selected' : ''}`}
          style={{ '--peer-color': peer.color || '#888780' }}
          title={isSelf ? peer.name + ' (you)' : peer.name}
          onClick={clickable ? (e) => { e.stopPropagation(); setCompactPopover((p) => p === peer.userId ? null : peer.userId); } : undefined}
        >
          <div className="compact-orb-inner">{initial}</div>
        </div>
      );
    }

    return (
      <div className="widget-container compact" ref={containerRef} onMouseDown={startWindowDrag}>

        {/* Self solo — shown when self has no active pair */}
        {selfPairs.length === 0 && (
          <div className="compact-pair-row">
            {renderCompactOrb({ ...self, online: connected }, true, selfStatus, false)}
          </div>
        )}

        {/* Self pair rows */}
        {selfPairs.map(({ rel, partner }) => (
          <div key={rel.id} className="compact-pair-row">
            {renderCompactOrb({ ...self, online: connected }, true, selfStatus, false)}
            <div className={`compact-connector ${rel.state}`} />
            {renderCompactOrb(partner, false, partner.online !== false ? 'online' : 'offline', true)}
          </div>
        ))}

        {/* Divider before peer pairs / solos */}
        {(peerPairs.length > 0 || soloPeers.length > 0) && <div className="widget-divider" />}

        {/* Peer-to-peer pair rows */}
        {peerPairs.map(({ rel, peerA, peerB }) => (
          <div key={rel.id} className="compact-pair-row">
            {renderCompactOrb(peerA, false, peerA.online !== false ? 'online' : 'offline', false)}
            <div className={`compact-connector ${rel.state}`} />
            {renderCompactOrb(peerB, false, peerB.online !== false ? 'online' : 'offline', false)}
          </div>
        ))}

        {/* Solo peers — horizontal mini-cluster */}
        {soloPeers.length > 0 && (
          <div className="compact-solo-cluster">
            {soloPeers.slice(0, 4).map((peer) =>
              renderCompactOrb(peer, false, peer.online !== false ? 'online' : 'offline', true)
            )}
            {soloPeers.length > 4 && <div className="compact-more">+{soloPeers.length - 4}</div>}
          </div>
        )}

        {/* Inline action panel — expands when a peer orb is clicked */}
        {popoverPeer && (
          <div className="compact-action-panel">
            <span className="compact-action-name">{popoverPeer.name}</span>
            <button
              className={`compact-action-btn${popoverRel?.state === 'working_with' ? ' active' : ''}`}
              onClick={() => { handleSetRelationship(popoverPeer, 'working_with'); setCompactPopover(null); }}
            >Working with</button>
            <button
              className={`compact-action-btn${popoverRel?.state === 'waiting_for' ? ' active' : ''}`}
              onClick={() => { handleSetRelationship(popoverPeer, 'waiting_for'); setCompactPopover(null); }}
            >Waiting for</button>
            <button
              className={`compact-action-btn${!popoverRel?.state ? ' active' : ''}`}
              onClick={() => { handleSetRelationship(popoverPeer, null); setCompactPopover(null); }}
            >Clear</button>
          </div>
        )}
      </div>
    );
  }

  // ── Normal view layout ─────────────────────────────────────────────────────
  const hasPairsOrSolo = selfPairs.length > 0 || peerPairs.length > 0 || soloPeers.length > 0;
  const showCopyBtn = self.role === 'host' && !!buildInviteLink(self) && peers.length === 0;

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderPopover(peer, currentRelState) {
    return (
      <div className="relationship-popover no-drag">
        <button
          className={`popover-option${currentRelState === 'working_with' ? ' active' : ''}`}
          onClick={() => handleSetRelationship(peer, 'working_with')}
        >Working with</button>
        <button
          className={`popover-option${currentRelState === 'waiting_for' ? ' active' : ''}`}
          onClick={() => handleSetRelationship(peer, 'waiting_for')}
        >Waiting for</button>
        <button
          className={`popover-option${!currentRelState ? ' active' : ''}`}
          onClick={() => handleSetRelationship(peer, null)}
        >Clear</button>
      </div>
    );
  }

  function renderPairCard(leftPeer, rightPeer, rel, leftIsSelf) {
    const leftOnline = leftIsSelf ? connected : leftPeer.online !== false;
    const relClass = rel.state === 'working_with' ? 'working-with' : 'waiting-for';
    const bridgeLabel = rel.state === 'working_with' ? 'working' : 'waiting';
    const popoverPeer = !leftIsSelf && activePopover === leftPeer.userId ? leftPeer
                      : activePopover === rightPeer.userId ? rightPeer
                      : null;

    return (
      <React.Fragment key={rel.id}>
        <div className={`pair-card ${relClass}`}>
          <div className="pair-row">
            {/* Left circle */}
            <PeerCircle
              peer={{ ...leftPeer, online: leftOnline }}
              isSelf={leftIsSelf}
              isPaired={false}
              relationship={null}
              relayError={leftIsSelf && guestUnreachable}
              onClick={leftIsSelf ? () => {} : () => handlePeerClick(leftPeer)}
            />
            <div className="pair-line" />
            {/* Right circle */}
            <PeerCircle
              peer={rightPeer}
              isSelf={false}
              isPaired={false}
              relationship={null}
              onClick={() => handlePeerClick(rightPeer)}
            />
          </div>
          <div className="pair-label">{bridgeLabel}</div>
        </div>
        {popoverPeer && renderPopover(popoverPeer, rel.state)}
      </React.Fragment>
    );
  }

  function renderSoloPeer(peer) {
    const rel = getRelationship(selfId, peer.userId, relationships);
    return (
      <React.Fragment key={peer.userId}>
        <PeerCircle
          peer={peer}
          isSelf={false}
          isPaired={false}
          relationship={null}
          onClick={() => handlePeerClick(peer)}
        />
        {activePopover === peer.userId && renderPopover(peer, rel?.state || null)}
      </React.Fragment>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="widget-container" ref={containerRef} onMouseDown={startWindowDrag}>

      {/* Self — solo if no active relationships, otherwise moves into pair cards */}
      {selfPairs.length === 0 && (
        <PeerCircle
          peer={{ ...self, online: connected }}
          isSelf
          isPaired={false}
          relationship={null}
          relayError={guestUnreachable}
          onClick={() => {}}
        />
      )}

      {/* Self pair cards (self + partner side-by-side) */}
      {selfPairs.map(({ rel, partner }) =>
        renderPairCard({ ...self, online: connected }, partner, rel, true)
      )}

      {/* Divider before the rest of the team */}
      {hasPairsOrSolo && (peerPairs.length > 0 || soloPeers.length > 0) && (
        <div className="widget-divider" />
      )}

      {/* Pair cards between other peers */}
      {peerPairs.map(({ rel, peerA, peerB }) =>
        renderPairCard(peerA, peerB, rel, false)
      )}

      {/* Solo peers */}
      {soloPeers.map((peer) => renderSoloPeer(peer))}

      {/* Copy-link button — host only, until first peer joins */}
      {showCopyBtn && (
        <>
          <div className="widget-divider" />
          <button className="copy-link-btn no-drag" onClick={handleCopy} title={buildInviteLink(self)}>
            {copyLabel}
          </button>
          {!tunnelReady && (
            <p style={{ fontSize: '10px', color: '#999', textAlign: 'center', margin: '2px 8px 0', lineHeight: 1.3 }}>
              {self.wsUrl?.startsWith('ws://')
                ? 'Same network only · relay connecting…'
                : 'Relay connecting…'}
            </p>
          )}
        </>
      )}

      {/* Reconnect banner — shown when the team relay is unreachable */}
      {guestUnreachable && (
        <>
          <div className="widget-divider" />
          <div className="reconnect-banner no-drag">
            <p className="reconnect-msg">Can't reach the relay. Retrying automatically… To reconnect faster, ask your host for a fresh invite link (or a local invite link if you're on the same network).</p>
            <input
              className="reconnect-input"
              type="text"
              placeholder="Paste nearby://join/… link"
              value={newLink}
              onChange={(e) => setNewLink(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRelink()}
            />
            {linkError && <p className="reconnect-error">{linkError}</p>}
            <button className="reconnect-btn" onClick={handleRelink}>Reconnect</button>
          </div>
        </>
      )}

      {/* Update button — hidden when up to date */}
      {(updateState === 'downloading' || updateState === 'ready') && (
        <>
          <div className="widget-divider" />
          <button
            className={`update-btn no-drag${updateState === 'ready' ? ' update-btn-ready' : ''}`}
            disabled={updateState === 'downloading'}
            onClick={updateState === 'ready' ? () => window.electronAPI.installUpdate() : undefined}
          >
            {updateState === 'downloading' ? '↓ Downloading update…' : '↑ Restart to update'}
          </button>
        </>
      )}
    </div>
  );
}
