/**
 * DebugModeAffordance — global keyboard shortcut + floating indicator.
 *
 * Mount once at the app root. Adds:
 *   - Ctrl/Cmd+Shift+D toggles debug mode.
 *   - When debug mode is ON, a tiny "DEBUG" pill renders in the
 *     bottom-left corner.
 *   - Clicking the pill opens a {@link FeatureFlagsPanel} so the user
 *     can flip experimental features and disable debug mode from there.
 *
 * The component is self-contained: no props, no context. It reads/writes
 * via the {@link debug.ts} module so behaviour is consistent with the
 * rest of the recorder pipeline.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  debugFlagStore,
  isDebugEnabled,
  setDebugEnabled,
} from "../debug.ts";
import { FeatureFlagsPanel } from "./FeatureFlagsPanel.tsx";

export function DebugModeAffordance() {
  const enabled = useSyncExternalStore(
    debugFlagStore.subscribe,
    debugFlagStore.getSnapshot,
    debugFlagStore.getSnapshot,
  );
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS).
      // Avoid bare Ctrl+D which collides with browser bookmark dialogs.
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setDebugEnabled(!isDebugEnabled());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Close the panel automatically when debug mode is turned off.
  useEffect(() => {
    if (!enabled) setPanelOpen(false);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        data-debug-pill=""
        onClick={() => setPanelOpen((p) => !p)}
        aria-pressed={panelOpen}
        aria-label="Open debug menu"
        title="Open debug menu (feature flags, disable debug)"
        style={{
          position: "fixed",
          bottom: 12,
          left: 12,
          zIndex: 9999,
          padding: "4px 10px",
          borderRadius: 999,
          border: "1px solid var(--border-default)",
          background: "var(--bg-elevated, #2a1a1a)",
          color: "var(--text-danger, #d04444)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: 0.6,
          cursor: "pointer",
          boxShadow: "var(--shadow-md)",
        }}
      >
        ● DEBUG
      </button>
      {panelOpen && (
        <FeatureFlagsPanel
          onClose={() => setPanelOpen(false)}
          onDisableDebug={() => {
            setDebugEnabled(false);
            setPanelOpen(false);
          }}
        />
      )}
    </>
  );
}
