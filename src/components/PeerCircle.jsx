// PeerCircle.jsx — A single user avatar: colored circle + name + online indicator

import React from 'react';

export default function PeerCircle({ peer, isSelf, isPaired, relationship, relayError, onClick }) {
  const initial = (peer.name || '?')[0].toUpperCase();
  const online = peer.online !== false; // default true if field missing

  const ringClass = [
    'peer-ring',
    online ? 'online' : (relayError ? 'relay-error' : 'offline'),
    isPaired ? 'paired' : '',
    isSelf && !online ? 'self-disconnected' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={`peer-circle-wrapper ${isSelf ? 'is-self' : ''}`}
      onClick={onClick}
      title={peer.name}
      style={{ '--peer-color': peer.color || '#888780' }}
    >
      <div className={ringClass}>
        <div className="peer-inner">
          {initial}
        </div>
      </div>
      <span className={`peer-name ${online ? '' : 'offline-label'} ${isSelf ? 'self-label' : ''}`}>
        {isSelf ? peer.name + ' (you)' : peer.name}
      </span>
      {relationship && (
        <span className={`relationship-pill ${relationship === 'working_with' ? 'working' : 'waiting'}`}>
          {relationship === 'working_with' ? 'working' : 'waiting'}
        </span>
      )}
    </div>
  );
}
