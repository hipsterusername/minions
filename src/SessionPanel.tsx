import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import type { ServerMessage, SessionInfo } from "./use-socket.ts";
import { UsageSection } from "./UsagePopover.tsx";
import {
  emptySessionUsage,
  mergeUsageEvent,
  mergeDoneEvent,
  type SessionUsage,
} from "./usage-aggregator.ts";
import {
  DockPanel,
  DockPanelHeader,
  useDockBadge,
  useDockPanelOpen,
} from "./BottomRightDock.tsx";

interface SessionPanelProps {
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: ((fn: (msg: unknown) => void) => () => void) | undefined;
  socketConnected?: boolean | undefined;
  onAttachSession: (sessionKey: string, role?: "leader" | "minion" | "default" | "card-composer") => void;
  onFocusSession?: (sessionKey: string) => void;
  attachedSessionKeys: Set<string>;
}

export function SessionPanel({
  socketSend,
  socketSubscribe,
  socketConnected,
  onAttachSession,
  onFocusSession,
  attachedSessionKeys,
}: SessionPanelProps) {
  const isOpen = useDockPanelOpen("sessions");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [unattachedOpen, setUnattachedOpen] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [usageBySession, setUsageBySession] = useState<
    ReadonlyMap<string, SessionUsage>
  >(new Map());

  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as ServerMessage;

      if (serverMsg.type === "session_list") {
        setSessions(serverMsg.sessions);
        return;
      }

      if (serverMsg.type === "session_status") {
        setSessions((prev) => {
          const existing = prev.find(
            (s) => s.sessionKey === serverMsg.sessionKey,
          );
          if (existing) {
            return prev.map((s) =>
              s.sessionKey === serverMsg.sessionKey
                ? { ...s, status: serverMsg.status }
                : s,
            );
          }
          return [
            ...prev,
            {
              sessionKey: serverMsg.sessionKey,
              sessionId: serverMsg.sessionId ?? null,
              status: serverMsg.status,
              cwd: "",
            },
          ];
        });
        return;
      }

      if (serverMsg.type === "session_task_name") {
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionKey === serverMsg.sessionKey
              ? { ...s, taskName: serverMsg.taskName }
              : s,
          ),
        );
        return;
      }

      if (serverMsg.type === "session_created") {
        setSessions((prev) => {
          if (prev.some((s) => s.sessionKey === serverMsg.sessionKey)) {
            return prev;
          }
          return [
            ...prev,
            {
              sessionKey: serverMsg.sessionKey,
              sessionId: null,
              status: "creating",
              cwd: "",
            },
          ];
        });
        return;
      }

      // Per-session usage roll-up — fed by NormalizedEvent usage/done events.
      if (serverMsg.type === "sdk_event") {
        const key = serverMsg.sessionKey;
        const ev = serverMsg.event;
        if (ev.kind === "usage" && ev.costUSD != null) {
          const costUSD = ev.costUSD;
          setUsageBySession((prev) => {
            const next = new Map(prev);
            next.set(key, mergeUsageEvent(prev.get(key) ?? emptySessionUsage(), costUSD));
            return next;
          });
        }
        if (ev.kind === "done" && ev.turns != null) {
          const turns = ev.turns;
          setUsageBySession((prev) => {
            const next = new Map(prev);
            next.set(key, mergeDoneEvent(prev.get(key) ?? emptySessionUsage(), turns));
            return next;
          });
        }
      }
    });
  }, [socketSubscribe]);

  // Request session list on connect
  useEffect(() => {
    if (socketConnected && socketSend) {
      socketSend({ type: "list_sessions" });
    }
  }, [socketConnected, socketSend]);

  const handleStop = useCallback(
    (sessionKey: string) => {
      if (!socketSend) return;
      socketSend({ type: "stop_session", sessionKey });
    },
    [socketSend],
  );

  const statusColor: Record<string, string> = {
    creating: "var(--status-creating)",
    running: "var(--status-success)",
    idle: "var(--status-idle)",
    stopped: "var(--danger-color-text)",
    error: "var(--danger-color)",
  };

  const visibleSessions = sessions.filter(
    (s) => s.role !== "minion" && s.role !== "card-composer",
  );
  const attachedSessions = visibleSessions.filter((s) =>
    attachedSessionKeys.has(s.sessionKey),
  );
  const unattachedSessions = visibleSessions.filter(
    (s) => !attachedSessionKeys.has(s.sessionKey),
  );
  const totalCost = visibleSessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);
  // Memoize the usage map identity so UsageSection only re-renders when an
  // SDK result actually folds new tokens in.
  const usageView = useMemo(() => usageBySession, [usageBySession]);

  const runningCount = visibleSessions.filter((s) => s.status === "running").length;

  // Prevent wheel events from bubbling to the canvas zoom handler.
  // Canvas uses a native addEventListener so React's onWheel stopPropagation
  // is ineffective — we need a native listener that fires first.
  // Depend on isOpen: the panel returns null when closed, so listRef.current
  // is null on initial mount. Re-running when isOpen becomes true ensures
  // the listener attaches after the div is in the DOM.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => { e.stopPropagation(); };
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, [isOpen]);

  // Surface live count + running indicator + cost on the dock pill.
  useDockBadge("sessions", {
    count: visibleSessions.length,
    dot: runningCount > 0 ? "success" : undefined,
    tail: totalCost > 0 ? `$${totalCost.toFixed(2)}` : undefined,
  });

  if (!isOpen) return null;

  return (
    <DockPanel id="sessions" width={260}>
      <DockPanelHeader
        title={
          <>
            Sessions ({visibleSessions.length})
            {totalCost > 0 && (
              <span
                style={{
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  textTransform: "none",
                  letterSpacing: 0,
                  fontWeight: 400,
                  marginLeft: 4,
                }}
              >
                · ${totalCost.toFixed(4)}
              </span>
            )}
          </>
        }
      />

      {/* Session list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "6px",
        }}
      >
        {visibleSessions.length === 0 && (
          <div
            style={{
              padding: "20px 12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 11,
              fontStyle: "italic",
            }}
          >
            No active sessions
          </div>
        )}
        {attachedSessions.length === 0 && unattachedSessions.length > 0 && (
          <div
            style={{
              padding: "12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 11,
              fontStyle: "italic",
            }}
            data-testid="no-attached-sessions"
          >
            No sessions on canvas
          </div>
        )}
        {attachedSessions.map((session) => {
          const isAttached = true;
          const color = statusColor[session.status] ?? "var(--text-muted)";

          return (
            <div
              key={session.sessionKey}
              data-testid="session-row-attached"
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                marginBottom: 4,
                background: "var(--bg-surface)",
                border: `1px solid ${isAttached ? "var(--accent)" : "var(--border-default)"}`,
                transition: "border-color 0.15s",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 4,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: color,
                      boxShadow:
                        session.status === "running"
                          ? `0 0 6px ${color}`
                          : "none",
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11,
                      color: session.taskName ? "var(--text-primary)" : "var(--text-primary)",
                      fontFamily: "var(--font-mono)",
                      fontWeight: session.taskName ? 600 : 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 140,
                    }}
                  >
                    {session.taskName ?? session.sessionKey.slice(0, 16)}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 9,
                    color,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                  }}
                >
                  {session.status}
                </span>
              </div>

              {/* Stats row */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 6,
                  fontSize: 10,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {(session.totalCost ?? 0) > 0 && (
                  <span>${session.totalCost?.toFixed(4)}</span>
                )}
                {(session.turns ?? 0) > 0 && (
                  <span>{session.turns}T</span>
                )}
              </div>

              {/* Active minion tags */}
              {(session.activeMinions ?? []).length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    marginBottom: 6,
                  }}
                >
                  {(session.activeMinions ?? []).map((minion) => (
                    <span
                      key={minion.taskId}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 7px",
                        fontSize: 9,
                        fontFamily: "var(--font-mono)",
                        background: "var(--warning-bg)",
                        border: "1px solid var(--warning-color)",
                        borderRadius: 10,
                        color: "var(--warning-color)",
                      }}
                    >
                      <span
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: "var(--warning-color)",
                          boxShadow: "0 0 4px var(--warning-color)",
                        }}
                      />
                      {minion.title.length > 20
                        ? minion.title.slice(0, 18) + "…"
                        : minion.title}
                    </span>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={() => onFocusSession?.(session.sessionKey)}
                  disabled={!onFocusSession}
                  style={{
                    flex: 1,
                    padding: "4px 0",
                    fontSize: 10,
                    background: "var(--bg-primary)",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    color: "var(--accent)",
                    cursor: onFocusSession ? "pointer" : "default",
                    fontFamily: "var(--font-mono)",
                  }}
                  title="Center canvas on this session"
                >
                  Focus
                </button>
                {session.status === "running" && (
                  <button
                    onClick={() => handleStop(session.sessionKey)}
                    style={{
                      padding: "4px 8px",
                      fontSize: 10,
                      background: "var(--danger-bg)",
                      border: "1px solid var(--danger-color)",
                      borderRadius: 4,
                      color: "var(--status-error)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Stop
                  </button>
                )}
                {(session.status === "idle" || session.status === "stopped" || session.status === "error") && (
                  <button
                    onClick={() => {
                      if (socketSend) {
                        socketSend({ type: "remove_session", sessionKey: session.sessionKey });
                      }
                    }}
                    style={{
                      padding: "4px 8px",
                      fontSize: 10,
                      background: "color-mix(in srgb, var(--status-stopped) 15%, transparent)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                    title="Remove session"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Unattached sessions: hidden under a collapsible section at the bottom */}
        {unattachedSessions.length > 0 && (
          <div style={{ marginTop: attachedSessions.length > 0 ? 8 : 0 }}>
            <button
              type="button"
              onClick={() => setUnattachedOpen((v) => !v)}
              aria-expanded={unattachedOpen}
              data-testid="unattached-toggle"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 8px",
                fontSize: 10,
                background: "transparent",
                border: "1px dashed var(--border-default)",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              <span>
                {unattachedOpen ? "▾" : "▸"} Not on canvas ({unattachedSessions.length})
              </span>
            </button>

            {unattachedOpen &&
              unattachedSessions.map((session) => {
                const color = statusColor[session.status] ?? "var(--text-muted)";
                return (
                  <div
                    key={session.sessionKey}
                    data-testid="session-row-unattached"
                    style={{
                      padding: "8px 10px",
                      borderRadius: 6,
                      marginTop: 4,
                      background: "var(--bg-surface)",
                      border: "1px solid var(--border-default)",
                      opacity: 0.85,
                      transition: "border-color 0.15s",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: color,
                            boxShadow:
                              session.status === "running" ? `0 0 6px ${color}` : "none",
                          }}
                        />
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-primary)",
                            fontFamily: "var(--font-mono)",
                            fontWeight: session.taskName ? 600 : 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 140,
                          }}
                        >
                          {session.taskName ?? session.sessionKey.slice(0, 16)}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 9,
                          color,
                          fontFamily: "var(--font-mono)",
                          textTransform: "uppercase",
                        }}
                      >
                        {session.status}
                      </span>
                    </div>

                    {/* Stats row */}
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginBottom: 6,
                        fontSize: 10,
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {(session.totalCost ?? 0) > 0 && (
                        <span>${session.totalCost?.toFixed(4)}</span>
                      )}
                      {(session.turns ?? 0) > 0 && <span>{session.turns}T</span>}
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        onClick={() => onAttachSession(session.sessionKey, session.role)}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          fontSize: 10,
                          background: "var(--bg-primary)",
                          border: "1px solid var(--border-default)",
                          borderRadius: 4,
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        Attach to canvas
                      </button>
                      {session.status === "running" && (
                        <button
                          onClick={() => handleStop(session.sessionKey)}
                          style={{
                            padding: "4px 8px",
                            fontSize: 10,
                            background: "var(--danger-bg)",
                            border: "1px solid var(--danger-color)",
                            borderRadius: 4,
                            color: "var(--status-error)",
                            cursor: "pointer",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          Stop
                        </button>
                      )}
                      {(session.status === "idle" ||
                        session.status === "stopped" ||
                        session.status === "error") && (
                        <button
                          onClick={() => {
                            if (socketSend) {
                              socketSend({
                                type: "remove_session",
                                sessionKey: session.sessionKey,
                              });
                            }
                          }}
                          style={{
                            padding: "4px 8px",
                            fontSize: 10,
                            background:
                              "color-mix(in srgb, var(--status-stopped) 15%, transparent)",
                            border: "1px solid var(--border-default)",
                            borderRadius: 4,
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            fontFamily: "var(--font-mono)",
                          }}
                          title="Remove session"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Usage section — pinned at the bottom of the panel */}
      <div
        style={{
          borderTop: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        <UsageSection sessions={usageView} />
      </div>
    </DockPanel>
  );
}
