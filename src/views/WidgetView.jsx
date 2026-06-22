// WidgetView.jsx — Floating always-on-top widget.
// Peers with active relationships appear side-by-side in pair cards.
// Solo peers (no active relationship) are listed individually below.

import React, { useState, useEffect, useRef } from 'react';
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

  useEffect(() => {
    const unsub = subscribe(setAppState);
    return unsub;
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

  // Resize height to content
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

  // ── Layout sections ───────────────────────────────────────────────────────

  const selfId = self.userId;
  const activeRels = (relationships || []).filter((r) => r.state);

  // Pairs that include self
  const selfPairs = activeRels
    .filter((r) => r.userA === selfId || r.userB === selfId)
    .map((r) => ({
      rel: r,
      partner: peers.find((p) => p.userId === (r.userA === selfId ? r.userB : r.userA)),
    }))
    .filter((item) => item.partner);

  // Pairs between other peers (neither is self)
  const peerPairs = activeRels
    .filter((r) => r.userA !== selfId && r.userB !== selfId)
    .map((r) => ({
      rel: r,
      peerA: peers.find((p) => p.userId === r.userA),
      peerB: peers.find((p) => p.userId === r.userB),
    }))
    .filter((item) => item.peerA && item.peerB);

  // Peers not in any pair
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
    <div className="widget-container" ref={containerRef}>

      {/* Self — solo if no active relationships, otherwise moves into pair cards */}
      {selfPairs.length === 0 && (
        <PeerCircle
          peer={{ ...self, online: connected }}
          isSelf
          isPaired={false}
          relationship={null}
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
            <p className="reconnect-msg">Team relay offline. Auto-reconnecting… or paste an invite link to retry.</p>
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
    </div>
  );
}
