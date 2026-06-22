// SetupView.jsx — First-launch screen: create a team (Host) or join one (Guest)

import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setState } from '../store/state.js';

// Derive a stable localtunnel subdomain from the channelId so the tunnel URL
// is the same every session — guests can reconnect without a new invite link.
function channelSubdomain(channelId) {
  return 'nearby-' + channelId.replace(/-/g, '').slice(0, 12);
}

// Invite link format: nearby://join/{base64url(JSON.stringify({ws, channelId}))}
// base64url uses - for + and _ for / with no padding.
function parseDeepLink(url) {
  try {
    if (!url.startsWith('nearby://join/')) return null;
    const payload = url.slice('nearby://join/'.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(payload + '=='.slice(0, (4 - payload.length % 4) % 4));
    const { ws, channelId } = JSON.parse(json);
    if (!ws || !channelId) return null;
    return { wsUrl: ws, channelId };
  } catch {
    return null;
  }
}

export default function SetupView({ onComplete }) {
  const [tab, setTab] = useState('create'); // 'create' | 'join'
  const [name, setName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Check for a deep link on mount (Windows/Linux: passed before renderer loaded)
  useEffect(() => {
    async function checkDeepLink() {
      const link = await window.electronAPI.getDeepLink();
      if (link) applyDeepLink(link);
    }
    checkDeepLink();
    const fn = window.electronAPI.onDeepLink((url) => applyDeepLink(url));
    return () => window.electronAPI.offDeepLink(fn);
  }, []);

  function applyDeepLink(url) {
    const parsed = parseDeepLink(url);
    if (parsed) {
      setTab('join');
      setInviteLink(url);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return setError('Please enter your name.');
    if (!teamName.trim()) return setError('Please enter a team name.');
    setError('');
    setLoading(true);

    try {
      const userId = uuidv4();
      const channelIdNew = uuidv4();
      const portNum = 4993;

      // Start embedded WS server + attempt a public tunnel (one try; background retry handles the rest)
      const result = await window.electronAPI.startServer(portNum, channelSubdomain(channelIdNew), 1);
      if (!result.ok) {
        setError('Could not start the server. Port 4993 may be in use.');
        setLoading(false);
        return;
      }

      // Use the tunnel URL when available; fall back to local IP so teammates on the
      // same network can join immediately. The widget updates wsUrl to the public URL
      // automatically when the background relay retry succeeds.
      let wsUrl;
      if (result.tunnelUrl) {
        wsUrl = result.tunnelUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
      } else {
        const localIP = await window.electronAPI.getLocalIP();
        wsUrl = `ws://${localIP}:${portNum}`;
      }

      const self = {
        userId,
        name: name.trim(),
        color: null,      // server assigns on HELLO
        channelId: channelIdNew,
        teamName: teamName.trim(),
        role: 'host',
        port: portNum,    // needed to restart the server on next launch
        wsUrl,            // public (or LAN fallback) URL guests use to connect
        pairedWith: null,
      };

      const stateData = { self, peers: [], relationships: [] };
      await window.electronAPI.writeState(stateData);

      // openWidget() creates the widget window and queues setup window close.
      // The widget window's own App.jsx hydrates from disk — no store transition needed here.
      await window.electronAPI.openWidget();
    } catch (err) {
      setError('Unexpected error: ' + err.message);
      setLoading(false);
    }
  }

  async function handleJoin(e) {
    e.preventDefault();
    if (!name.trim()) return setError('Please enter your name.');
    const parsed = parseDeepLink(inviteLink.trim());
    if (!parsed) return setError('Invalid invite link. Paste the full nearby://join/… link.');
    setError('');
    setLoading(true);

    try {
      const userId = uuidv4();

      // Use the deterministic channel URL regardless of what's in the invite link.
      // Whoever currently holds the relay will have this subdomain. If nobody does,
      // the auto-promote logic in useWebSocket will acquire it after a few retries.
      // Exception: LAN invite links (non-loca.lt) are kept as-is.
      const deterministicUrl = `wss://${channelSubdomain(parsed.channelId)}.loca.lt`;
      const wsUrl = parsed.wsUrl.includes('.loca.lt') ? deterministicUrl : parsed.wsUrl;

      const self = {
        userId,
        name: name.trim(),
        color: null,
        channelId: parsed.channelId,
        teamName: '',
        role: 'guest',
        port: 4993,
        wsUrl,
        pairedWith: null,
      };

      const stateData = { self, peers: [], relationships: [] };
      await window.electronAPI.writeState(stateData);

      // openWidget() creates the widget window and queues setup window close.
      // The widget window's own App.jsx hydrates from disk — no store transition needed here.
      await window.electronAPI.openWidget();
    } catch (err) {
      setError('Unexpected error: ' + err.message);
      setLoading(false);
    }
  }

  return (
    <div className="setup-container">
      <div className="setup-logo">
        <div className="setup-logo-orb" />
      </div>
      <h1 className="setup-title">Nearby</h1>
      <p className="setup-subtitle">Team presence, no cloud required.</p>

      <div className="setup-tabs">
        <button
          className={`setup-tab ${tab === 'create' ? 'active' : ''}`}
          onClick={() => { setTab('create'); setError(''); }}
        >
          Create Team
        </button>
        <button
          className={`setup-tab ${tab === 'join' ? 'active' : ''}`}
          onClick={() => { setTab('join'); setError(''); }}
        >
          Join Team
        </button>
      </div>

      {tab === 'create' && (
        <form className="setup-form" onSubmit={handleCreate}>
          <label className="setup-label">Your name</label>
          <input
            className="setup-input"
            type="text"
            placeholder="e.g. Hady"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            autoFocus
          />
          <label className="setup-label">Team name</label>
          <input
            className="setup-input"
            type="text"
            placeholder="e.g. IhsanDev"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            maxLength={48}
          />
          {error && <p className="setup-error">{error}</p>}
          <button className="setup-btn" type="submit" disabled={loading}>
            {loading ? 'Starting…' : 'Create Team →'}
          </button>
        </form>
      )}

      {tab === 'join' && (
        <form className="setup-form" onSubmit={handleJoin}>
          <label className="setup-label">Your name</label>
          <input
            className="setup-input"
            type="text"
            placeholder="e.g. Sara"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            autoFocus
          />
          <label className="setup-label">Invite link</label>
          <input
            className="setup-input"
            type="text"
            placeholder="Paste nearby://join/… link here"
            value={inviteLink}
            onChange={(e) => setInviteLink(e.target.value)}
          />
          {error && <p className="setup-error">{error}</p>}
          <button className="setup-btn" type="submit" disabled={loading}>
            {loading ? 'Connecting…' : 'Join Team →'}
          </button>
        </form>
      )}
    </div>
  );
}
