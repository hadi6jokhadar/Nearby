// App.jsx — Root component. Hydrates state from disk on mount and routes between views.

import React, { useEffect, useState } from "react";

function channelSubdomain(channelId) {
  return "nearby-" + channelId.replace(/-/g, "").slice(0, 12);
}
import SetupView from "./views/SetupView.jsx";
import WidgetView from "./views/WidgetView.jsx";
import { getState, setState, subscribe } from "./store/state.js";

export default function App() {
  const [view, setView] = useState("loading");

  useEffect(() => {
    async function hydrate() {
      const saved = await window.electronAPI.readState();
      if (!saved?.self) {
        setState({ view: "setup" });
        setView("setup");
        return;
      }

      const { channelId, port = 4993 } = saved.self;
      const subdomain = channelSubdomain(channelId);
      const deterministicUrl = `wss://${subdomain}.loca.lt`;

      // Everyone races for the deterministic relay subdomain on startup (1 attempt = fast).
      // If the tunnel isn't available, the background retry in the main process will
      // establish it and notify the renderer via the tunnel-ready event.
      const result = await window.electronAPI.startServer(port, subdomain, 1);

      let updatedSelf;
      if (result.ok && result.tunnelUrl && result.subdomainHonored) {
        const wsUrl = result.tunnelUrl
          .replace(/^https:\/\//, "wss://")
          .replace(/^http:\/\//, "ws://");
        updatedSelf = { ...saved.self, role: "host", wsUrl, port };
      } else if (result.ok && result.tunnelUrl && !result.subdomainHonored) {
        // Lost the race — relay is already up, connect as guest.
        updatedSelf = { ...saved.self, role: "guest", wsUrl: deterministicUrl };
      } else {
        // Tunnel not yet available (timeout) or server start failed.
        // Hosts fall back to local IP so teammates on the same network can join immediately.
        // Guests keep their stored wsUrl (local IP or loca.lt from the invite link they used).
        if (saved.self.role === "host") {
          const localIP = await window.electronAPI.getLocalIP();
          updatedSelf = { ...saved.self, wsUrl: `ws://${localIP}:${port}` };
        } else {
          updatedSelf = { ...saved.self };
        }
      }

      await window.electronAPI.writeState({
        self: updatedSelf,
        peers: saved.peers || [],
        relationships: saved.relationships || [],
      });

      setState({
        self: updatedSelf,
        peers: (saved.peers || []).map((p) => ({ ...p, online: false })),
        relationships: saved.relationships || [],
        view: "widget",
      });
      setView("widget");
    }
    hydrate();

    // Subscribe to store view changes triggered from elsewhere (e.g. RESET handler)
    const unsub = subscribe((s) => setView(s.view));
    return unsub;
  }, []);

  if (view === "loading") {
    return <div className="loading-screen" />;
  }

  if (view === "setup") {
    return <SetupView onComplete={() => setView("widget")} />;
  }

  return (
    <WidgetView
      onReset={() => {
        setState({ view: "setup" });
        setView("setup");
      }}
    />
  );
}
