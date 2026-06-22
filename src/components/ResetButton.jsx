// ResetButton.jsx — Reset button with confirmation dialog (host-only action)

import React, { useState } from 'react';

export default function ResetButton({ isHost, onReset }) {
  const [confirming, setConfirming] = useState(false);

  if (!isHost) {
    return (
      <button
        className="reset-btn disabled"
        onClick={() => alert('Only the team host can reset the channel.')}
        title="Only the host can reset"
      >
        Reset
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="reset-confirm">
        <span className="reset-confirm-text">Disconnect everyone?</span>
        <button
          className="reset-btn confirm-yes"
          onClick={() => {
            setConfirming(false);
            onReset();
          }}
        >
          Yes
        </button>
        <button
          className="reset-btn confirm-no"
          onClick={() => setConfirming(false)}
        >
          No
        </button>
      </div>
    );
  }

  return (
    <button
      className="reset-btn"
      onClick={() => setConfirming(true)}
      title="Reset and disconnect all peers"
    >
      Reset
    </button>
  );
}
