import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronDown,
  Crosshair,
  Link2,
  Square,
  Trash2,
} from "lucide-react";
import type { ServerMessage, SessionInfo } from "./use-socket.ts";
import { UsageSection } from "./UsagePopover.tsx";
import {
  emptySessionUsage,
  formatSessionUsageLine,
  mergeDoneEvent,
  mergeUsageEvent,
  shortModelLabel,
  type SessionUsage,
} from "./usage-aggregator.ts";
import {
  DockPanel,
  DockPanelHeader,
  useDockBadge,
  useDockPanelOpen,
} from "./BottomRightDock.tsx";
import "./session-panel.css";

interface SessionPanelProps {
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: ((fn: (msg: unknown) => void) => () => void) | undefined;
  socketConnected?: boolean | undefined;
  projectPath?: string | undefined;
  onAttachSession: (
    sessionKey: string,
    role?: "leader" | "minion" | "default" | "card-composer",
  ) => void;
  onFocusSession?: (sessionKey: string) => void;
  attachedSessionKeys: Set<string>;
}

const STATUS_COLOR: Record<string, string> = {
  creating: "var(--status-creating)",
  running: "var(--status-success)",
  idle: "var(--status-idle)",
  stopped: "var(--status-stopped)",
  completed: "var(--status-success)",
  error: "var(--danger-color-text)",
};

const STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  creating: 1,
  error: 2,
  idle: 3,
  completed: 4,
  stopped: 5,
};

export function SessionPanel({
  socketSend,
  socketSubscribe,
  socketConnected,
  projectPath,
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
        setUsageBySession(
          new Map(
            serverMsg.sessions.map((session) => [
              session.sessionKey,
              usageFromSessionInfo(session),
            ]),
          ),
        );
        return;
      }

      if (serverMsg.type === "session_status") {
        setSessions((previous) => {
          const exists = previous.some(
            (session) => session.sessionKey === serverMsg.sessionKey,
          );
          if (exists) {
            return previous.map((session) =>
              session.sessionKey === serverMsg.sessionKey
                ? { ...session, status: serverMsg.status }
                : session,
            );
          }
          return [
            ...previous,
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
        setSessions((previous) =>
          previous.map((session) =>
            session.sessionKey === serverMsg.sessionKey
              ? { ...session, taskName: serverMsg.taskName }
              : session,
          ),
        );
        return;
      }

      if (serverMsg.type === "session_created") {
        setSessions((previous) => {
          if (
            previous.some(
              (session) => session.sessionKey === serverMsg.sessionKey,
            )
          ) {
            return previous;
          }
          return [
            ...previous,
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

      if (serverMsg.type !== "sdk_event") return;
      const key = serverMsg.sessionKey;
      const event = serverMsg.event;
      if (event.kind === "usage") {
        setUsageBySession((previous) => {
          const next = new Map(previous);
          next.set(
            key,
            mergeUsageEvent(previous.get(key) ?? emptySessionUsage(), event),
          );
          return next;
        });
        const costUSD = event.costUSD;
        if (costUSD != null) {
          setSessions((previous) =>
            previous.map((session) =>
              session.sessionKey === key
                ? { ...session, totalCost: costUSD }
                : session,
            ),
          );
        }
      }
      if (event.kind === "done" && event.turns != null) {
        const turns = event.turns;
        setUsageBySession((previous) => {
          const next = new Map(previous);
          next.set(
            key,
            mergeDoneEvent(previous.get(key) ?? emptySessionUsage(), turns),
          );
          return next;
        });
        setSessions((previous) =>
          previous.map((session) =>
            session.sessionKey === key
              ? { ...session, turns }
              : session,
          ),
        );
      }
    });
  }, [socketSubscribe]);

  useEffect(() => {
    if (socketConnected && socketSend) {
      socketSend({ type: "list_sessions" });
    }
  }, [socketConnected, socketSend]);

  const handleStop = useCallback(
    (sessionKey: string) => {
      socketSend?.({ type: "stop_session", sessionKey });
    },
    [socketSend],
  );

  const handleRemove = useCallback(
    (sessionKey: string) => {
      socketSend?.({ type: "remove_session", sessionKey });
    },
    [socketSend],
  );

  const handleClearInactive = useCallback(() => {
    if (!socketSend) return;
    for (const session of sessionsRef.current) {
      const inCurrentPanel =
        attachedSessionKeys.has(session.sessionKey) ||
        isSessionInProject(session, projectPath);
      if (
        isVisibleSession(session) &&
        inCurrentPanel &&
        isSessionClearable(session)
      ) {
        socketSend({
          type: "remove_session",
          sessionKey: session.sessionKey,
        });
      }
    }
  }, [attachedSessionKeys, projectPath, socketSend]);

  const visibleSessions = sessions.filter(
    (session) =>
      isVisibleSession(session) &&
      (attachedSessionKeys.has(session.sessionKey) ||
        isSessionInProject(session, projectPath)),
  );
  const removableSessions = visibleSessions.filter(isSessionClearable);
  const attachedSessions = sortSessions(
    visibleSessions.filter((session) =>
      attachedSessionKeys.has(session.sessionKey),
    ),
  );
  const unattachedSessions = sortSessions(
    visibleSessions.filter(
      (session) => !attachedSessionKeys.has(session.sessionKey),
    ),
  );
  const totalCost = visibleSessions.reduce(
    (sum, session) => sum + (session.totalCost ?? 0),
    0,
  );
  const runningCount = visibleSessions.filter(
    (session) => session.status === "running",
  ).length;

  // The panel intentionally excludes minion and card-composer sessions, so
  // its summary must use that same scope.
  const usageView = useMemo(
    () =>
      new Map(
        visibleSessions.map((session) => [
          session.sessionKey,
          usageBySession.get(session.sessionKey) ??
            usageFromSessionInfo(session),
        ]),
      ),
    [sessions, usageBySession],
  );

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const element = listRef.current;
    if (!element) return;
    const stopCanvasZoom = (event: WheelEvent) => event.stopPropagation();
    element.addEventListener("wheel", stopCanvasZoom, { passive: false });
    return () => element.removeEventListener("wheel", stopCanvasZoom);
  }, [isOpen]);

  useDockBadge("sessions", {
    count: visibleSessions.length,
    dot: runningCount > 0 ? "success" : undefined,
    tail: totalCost > 0 ? `$${totalCost.toFixed(2)}` : undefined,
  });

  if (!isOpen) return null;

  return (
    <DockPanel id="sessions" width={320}>
      <DockPanelHeader
        title={
          <>
            Sessions
            <span className="session-panel__count">{visibleSessions.length}</span>
          </>
        }
        actions={
          <button
            type="button"
            className="session-panel__header-action"
            onClick={handleClearInactive}
            disabled={!socketSend || removableSessions.length === 0}
            aria-label="Clear inactive sessions"
            title={
              removableSessions.length > 0
                ? `Remove ${removableSessions.length} inactive session${
                    removableSessions.length === 1 ? "" : "s"
                  }`
                : "No inactive sessions to remove"
            }
          >
            <Trash2 aria-hidden="true" size={12} strokeWidth={1.8} />
            Clear inactive
          </button>
        }
      />

      <div ref={listRef} className="session-panel__body">
        {socketConnected === false && (
          <div className="session-panel__notice" role="status">
            Session controls are unavailable while the server reconnects.
          </div>
        )}

        {visibleSessions.length === 0 ? (
          <EmptySessions />
        ) : (
          <>
            <SessionGroupLabel
              label="On canvas"
              count={attachedSessions.length}
            />
            {attachedSessions.length === 0 ? (
              <p
                className="session-panel__empty-inline"
                data-testid="no-attached-sessions"
              >
                No sessions are attached to this canvas.
              </p>
            ) : (
              <div className="session-panel__list">
                {attachedSessions.map((session) => (
                  <SessionRow
                    key={session.sessionKey}
                    session={session}
                    attached
                    usage={
                      usageBySession.get(session.sessionKey) ??
                      usageFromSessionInfo(session)
                    }
                    controlsAvailable={Boolean(socketSend)}
                    onFocusSession={onFocusSession}
                    onAttachSession={onAttachSession}
                    onStop={handleStop}
                    onRemove={handleRemove}
                  />
                ))}
              </div>
            )}

            {unattachedSessions.length > 0 && (
              <section className="session-panel__unattached">
                <button
                  type="button"
                  className="session-panel__group-toggle"
                  onClick={() => setUnattachedOpen((open) => !open)}
                  aria-expanded={unattachedOpen}
                  data-testid="unattached-toggle"
                >
                  <span>
                    Not on canvas
                    <span className="session-panel__group-count">
                      {unattachedSessions.length}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    size={14}
                    strokeWidth={1.8}
                    className={
                      unattachedOpen
                        ? "session-panel__chevron session-panel__chevron--open"
                        : "session-panel__chevron"
                    }
                  />
                </button>

                {unattachedOpen && (
                  <div className="session-panel__list session-panel__list--unattached">
                    {unattachedSessions.map((session) => (
                      <SessionRow
                        key={session.sessionKey}
                        session={session}
                        attached={false}
                        usage={
                          usageBySession.get(session.sessionKey) ??
                          usageFromSessionInfo(session)
                        }
                        controlsAvailable={Boolean(socketSend)}
                        onFocusSession={onFocusSession}
                        onAttachSession={onAttachSession}
                        onStop={handleStop}
                        onRemove={handleRemove}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <div className="session-panel__usage">
        <UsageSection sessions={usageView} />
      </div>
    </DockPanel>
  );
}

function SessionGroupLabel({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <div className="session-panel__group-label">
      <span>{label}</span>
      <span>{count}</span>
    </div>
  );
}

function EmptySessions() {
  return (
    <div className="session-panel__empty">
      <span className="session-panel__empty-icon" aria-hidden="true">
        ◌
      </span>
      <strong>No sessions yet</strong>
      <span>Start work on the canvas and active sessions will appear here.</span>
    </div>
  );
}

interface SessionRowProps {
  session: SessionInfo;
  attached: boolean;
  usage: SessionUsage;
  controlsAvailable: boolean;
  onFocusSession?: ((sessionKey: string) => void) | undefined;
  onAttachSession: SessionPanelProps["onAttachSession"];
  onStop: (sessionKey: string) => void;
  onRemove: (sessionKey: string) => void;
}

function SessionRow({
  session,
  attached,
  usage,
  controlsAvailable,
  onFocusSession,
  onAttachSession,
  onStop,
  onRemove,
}: SessionRowProps) {
  const displayName = session.taskName?.trim() || "Untitled session";
  const statusColor =
    STATUS_COLOR[session.status] ?? "var(--text-muted)";
  const usageLine = formatSessionUsageLine(usage);
  const metadata = [
    session.harness,
    session.model ? shortModelLabel(session.model) : null,
  ].filter((value): value is string => Boolean(value));
  const style = { "--session-status": statusColor } as CSSProperties;

  return (
    <article
      className="session-card"
      data-testid={
        attached ? "session-row-attached" : "session-row-unattached"
      }
      data-status={session.status}
      style={style}
    >
      <div className="session-card__heading">
        <span className="session-card__status-dot" aria-hidden="true" />
        <div className="session-card__identity">
          <strong title={session.taskName ?? session.sessionKey}>
            {displayName}
          </strong>
          <span title={metadata.join(" · ") || session.sessionKey}>
            {metadata.length > 0
              ? metadata.join(" · ")
              : session.sessionKey.slice(0, 24)}
          </span>
        </div>
        <span className="session-card__status">{session.status}</span>
      </div>

      {((session.totalCost ?? 0) > 0 ||
        (session.turns ?? 0) > 0 ||
        usageLine) && (
        <div className="session-card__stats">
          {(session.totalCost ?? 0) > 0 && (
            <span>${session.totalCost!.toFixed(4)}</span>
          )}
          {(session.turns ?? 0) > 0 && <span>{session.turns} turns</span>}
          {usageLine && <span className="session-card__tokens">{usageLine}</span>}
        </div>
      )}

      {(session.activeMinions ?? []).length > 0 && (
        <div className="session-card__delegates">
          <span className="session-card__delegates-label">Delegated</span>
          <div>
            {(session.activeMinions ?? []).map((minion) => (
              <span
                className="session-card__delegate"
                key={minion.taskId}
                title={`${minion.title} · ${minion.status}`}
              >
                <span aria-hidden="true" />
                {minion.title}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="session-card__actions">
        {attached ? (
          <button
            type="button"
            className="session-card__button session-card__button--primary"
            onClick={() => onFocusSession?.(session.sessionKey)}
            disabled={!onFocusSession}
            title="Center the canvas on this session"
          >
            <Crosshair aria-hidden="true" size={12} />
            Focus
          </button>
        ) : (
          <button
            type="button"
            className="session-card__button session-card__button--primary"
            onClick={() => onAttachSession(session.sessionKey, session.role)}
            title="Create a canvas node for this session"
          >
            <Link2 aria-hidden="true" size={12} />
            Attach to canvas
          </button>
        )}

        {session.status === "running" && (
          <button
            type="button"
            className="session-card__button session-card__button--danger"
            onClick={() => onStop(session.sessionKey)}
            disabled={!controlsAvailable}
            title={
              controlsAvailable
                ? "Stop this session"
                : "Reconnect to stop this session"
            }
          >
            <Square aria-hidden="true" size={10} fill="currentColor" />
            Stop
          </button>
        )}

        {isSessionClearable(session) && (
          <button
            type="button"
            className="session-card__icon-button"
            onClick={() => onRemove(session.sessionKey)}
            disabled={!controlsAvailable}
            aria-label={`Remove ${displayName}`}
            title={
              controlsAvailable
                ? "Remove session"
                : "Reconnect to remove this session"
            }
          >
            <Trash2 aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </article>
  );
}

function usageFromSessionInfo(session: SessionInfo): SessionUsage {
  const usage = emptySessionUsage();
  usage.totalCost = session.totalCost ?? 0;
  usage.turns = session.turns ?? 0;
  if (session.usageTotals) {
    usage.input = session.usageTotals.input;
    usage.output = session.usageTotals.output;
    usage.cacheRead = session.usageTotals.cacheRead;
    usage.cacheCreation = session.usageTotals.cacheCreation;
    usage.cacheHitRate = session.usageTotals.cacheHitRate;
  }
  return usage;
}

function isVisibleSession(session: SessionInfo): boolean {
  return session.role !== "minion" && session.role !== "card-composer";
}

function isSessionInProject(
  session: SessionInfo,
  projectPath: string | undefined,
): boolean {
  if (!projectPath) return true;
  if (!session.cwd) return false;
  const project = normalizePath(projectPath);
  const cwd = normalizePath(session.cwd);
  return cwd === project || cwd.startsWith(`${project}/`);
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function isSessionClearable(session: SessionInfo): boolean {
  return (
    session.status === "idle" ||
    session.status === "stopped" ||
    session.status === "completed" ||
    session.status === "error"
  );
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((left, right) => {
    const statusDifference =
      (STATUS_PRIORITY[left.status] ?? 99) -
      (STATUS_PRIORITY[right.status] ?? 99);
    if (statusDifference !== 0) return statusDifference;
    const activityDifference =
      (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
    if (activityDifference !== 0) return activityDifference;
    const leftName = left.taskName ?? left.sessionKey;
    const rightName = right.taskName ?? right.sessionKey;
    return leftName.localeCompare(rightName);
  });
}
