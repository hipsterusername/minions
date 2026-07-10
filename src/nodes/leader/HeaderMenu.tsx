import { useEffect, useState } from "react";
import type { LeaderData } from "./types.ts";

/**
 * P6: Header menu — the ⋮ kebab in the leader-card header that exposes
 * "Save as preset", "Duplicate Setup", "Export Log", and "Reset Session"
 * actions.
 *
 * Closes itself on any wheel event (replaces the old canvasScale-prop
 * approach that caused every node to re-render on every zoom frame).
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 7 of the leader refactor).
 */
export function HeaderMenu({
  onReset,
  onExportLog,
  onDuplicateSetup,
  onOpenSystemModel,
  onSavePreset,
  data,
}: {
  onReset: () => void;
  onExportLog: () => void;
  onDuplicateSetup?: (() => void) | undefined;
  onOpenSystemModel?: (() => void) | undefined;
  onSavePreset?:
    | ((input: {
        name: string;
        description?: string;
        systemPromptPrefix?: string;
      }) => boolean)
    | undefined;
  data: LeaderData;
}) {
  const [open, setOpen] = useState(false);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [presetSystemPromptPrefix, setPresetSystemPromptPrefix] = useState("");

  // Close menu on any wheel event (covers both zoom and pan).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("wheel", close, { passive: true, once: true });
    return () => window.removeEventListener("wheel", close);
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 14,
          padding: "2px 4px",
          lineHeight: 1,
          borderRadius: 3,
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
      >
        ⋮
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 998 }}
          />
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              zIndex: 999,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
              minWidth: 160,
            }}
          >
            {onSavePreset && (
              <>
                <button
                  onClick={() => setSaveFormOpen((v) => !v)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "8px 12px",
                    background: "transparent",
                    border: "none",
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--bg-surface)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <span style={{ opacity: 0.6 }}>+</span> Save as preset...
                </button>
                {saveFormOpen && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: 10,
                      borderTop: "1px solid var(--border-default)",
                      borderBottom: "1px solid var(--border-default)",
                      background: "var(--bg-secondary)",
                    }}
                  >
                    <input
                      value={presetName}
                      onChange={(e) => setPresetName(e.currentTarget.value)}
                      placeholder="Name"
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        borderRadius: 4,
                        border: "1px solid var(--border-default)",
                        background: "var(--bg-surface)",
                        color: "var(--text-primary)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                    <input
                      value={presetDescription}
                      onChange={(e) => setPresetDescription(e.currentTarget.value)}
                      placeholder="Description"
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        borderRadius: 4,
                        border: "1px solid var(--border-default)",
                        background: "var(--bg-surface)",
                        color: "var(--text-primary)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                    <textarea
                      value={presetSystemPromptPrefix}
                      onChange={(e) =>
                        setPresetSystemPromptPrefix(e.currentTarget.value)
                      }
                      placeholder="System prompt prefix"
                      rows={3}
                      style={{
                        width: "100%",
                        resize: "vertical",
                        padding: "6px 8px",
                        borderRadius: 4,
                        border: "1px solid var(--border-default)",
                        background: "var(--bg-surface)",
                        color: "var(--text-primary)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                    <button
                      onClick={() => {
                        if (!presetName.trim()) return;
                        const saved = onSavePreset({
                          name: presetName,
                          description: presetDescription,
                          systemPromptPrefix: presetSystemPromptPrefix,
                        });
                        if (saved) {
                          setOpen(false);
                          setSaveFormOpen(false);
                          setPresetName("");
                          setPresetDescription("");
                          setPresetSystemPromptPrefix("");
                        }
                      }}
                      disabled={!presetName.trim()}
                      style={{
                        padding: "6px 8px",
                        borderRadius: 4,
                        border: "1px solid var(--accent)",
                        background: presetName.trim()
                          ? "var(--accent)"
                          : "var(--bg-surface)",
                        color: presetName.trim()
                          ? "var(--text-on-accent)"
                          : "var(--text-muted)",
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        cursor: presetName.trim() ? "pointer" : "default",
                      }}
                    >
                      Save
                    </button>
                  </div>
                )}
              </>
            )}
            {onDuplicateSetup && (
              <button
                onClick={() => {
                  onDuplicateSetup();
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--bg-surface)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span style={{ opacity: 0.6 }}>⧉</span> Duplicate Setup
              </button>
            )}
            {onOpenSystemModel && data.sessionKey && (
              <button
                onClick={() => {
                  onOpenSystemModel();
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--bg-surface)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span style={{ opacity: 0.6 }}>◫</span> Open System Model
              </button>
            )}
            <button
              onClick={() => {
                onExportLog();
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-surface)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <span style={{ opacity: 0.6 }}>↗</span> Export Log
            </button>
            {data.sessionKey && (
              <button
                onClick={() => {
                  onReset();
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  color: "var(--status-error)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--danger-bg)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span style={{ opacity: 0.6 }}>↺</span> Reset Session
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
