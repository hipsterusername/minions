/**
 * FeatureFlagsPanel — debug-only popover that lists every registered
 * feature flag with a checkbox toggle.
 *
 * Surfaced from {@link DebugModeAffordance}: clicking the floating
 * "DEBUG" pill opens this panel above it. The panel is the **only**
 * place users flip flags from — there is intentionally no per-feature
 * UI, because the whole point of debug mode is "tools that aren't part
 * of the production surface."
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  FEATURE_FLAGS,
  getFeatureFlag,
  resetFeatureFlags,
  setFeatureFlag,
  subscribeFeatureFlags,
} from "../feature-flags.ts";

interface Props {
  onClose: () => void;
  /** Click "Disable debug mode" → caller flips the debug flag. */
  onDisableDebug: () => void;
}

const allFlagsStore = {
  subscribe(fn: () => void): () => void {
    return subscribeFeatureFlags(fn);
  },
  // Snapshot identity is intentionally a primitive — we don't need
  // a stable object reference because each row reads its own value.
  getSnapshot(): number {
    let h = 0;
    for (const def of FEATURE_FLAGS) h = h * 2 + (getFeatureFlag(def.id) ? 1 : 0);
    return h;
  },
};

export function FeatureFlagsPanel({ onClose, onDisableDebug }: Props) {
  // Re-render on any flag change.
  useSyncExternalStore(
    allFlagsStore.subscribe,
    allFlagsStore.getSnapshot,
    allFlagsStore.getSnapshot,
  );

  const ref = useRef<HTMLDivElement>(null);

  // Outside-click + Escape close the panel.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t || !ref.current) return;
      if (ref.current.contains(t)) return;
      // Don't fight the DEBUG pill itself — clicking it should toggle.
      const pill = document.querySelector("[data-debug-pill]");
      if (pill && pill.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-debug-flags-panel=""
      role="dialog"
      aria-label="Debug feature flags"
      style={{
        position: "fixed",
        bottom: 48,
        left: 12,
        zIndex: 9999,
        width: 280,
        background: "var(--bg-secondary, #1c1c1c)",
        border: "1px solid var(--border-default, #333)",
        borderRadius: 8,
        boxShadow: "var(--shadow-lg)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--text-primary)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          textTransform: "uppercase",
          letterSpacing: 0.8,
          fontSize: 10,
          color: "var(--text-secondary)",
        }}
      >
        <span>Feature flags</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: "0 4px",
          }}
        >
          ×
        </button>
      </header>

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 4,
          maxHeight: 320,
          overflowY: "auto",
        }}
      >
        {FEATURE_FLAGS.map((def) => {
          const value = getFeatureFlag(def.id);
          const inputId = `feature-flag-${def.id}`;
          return (
            <li
              key={def.id}
              style={{
                padding: "8px 6px",
                borderRadius: 4,
              }}
            >
              <label
                htmlFor={inputId}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  id={inputId}
                  type="checkbox"
                  checked={value}
                  onChange={(e) => setFeatureFlag(def.id, e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {def.label}
                  </span>
                  <span style={{ color: "var(--text-muted)", lineHeight: 1.4 }}>
                    {def.description}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <footer
        style={{
          padding: "6px 10px",
          borderTop: "1px solid var(--border-default)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 11,
        }}
      >
        <button
          type="button"
          onClick={() => resetFeatureFlags()}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
            fontFamily: "inherit",
            fontSize: "inherit",
            textDecoration: "underline",
          }}
        >
          Reset to defaults
        </button>
        <button
          type="button"
          onClick={onDisableDebug}
          style={{
            background: "transparent",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            color: "var(--text-danger, #d04444)",
            cursor: "pointer",
            padding: "3px 8px",
            fontFamily: "inherit",
            fontSize: 10,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Disable debug
        </button>
      </footer>
    </div>
  );
}
