import { useEffect, useMemo, useState } from "react";

import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import {
  groupSessionsByActivity,
  needsAttention,
  sessionDisplayTitle,
  sessionRoleLabel,
} from "./mobile/mobile-selectors.ts";
import { timeAgo } from "./nodes/leader-message-helpers.ts";
import { SessionTranscript } from "./components/SessionTranscript.tsx";
import "./activity.css";

/**
 * Desktop Activity view — the default landing surface, mirroring the mobile
 * Activity screen on a wider canvas.
 *
 * Left: the live session list, grouped Active → Idle → Stopped (the same
 * `groupSessionsByActivity` selector mobile uses). Right: a kanban-style
 * inspector for the selected session showing its metadata, a live transcript,
 * and the actions to reveal it on the canvas or expand it into the existing
 * fullscreen cockpit.
 *
 * Sessions are matched to their canvas leader node by `sessionKey`; that
 * mapping is what unlocks the transcript + fullscreen actions for sessions
 * that live on the canvas. Sessions without a node (e.g. minions, or leaders
 * not yet placed) still appear and show their activity stream.
 */

export interface ActivityViewProps {
  sessions: MobileSessionInfo[];
  nodes: CanvasNode[];
  /** Create a fresh Leader node with the same defaults as Canvas. */
  onLaunchLeader: () => void;
  /** Reveal + center the leader node on the canvas. */
  onOpenInCanvas: (nodeId: string) => void;
  /** Reveal on canvas AND open the fullscreen cockpit. */
  onExpandFullscreen: (nodeId: string) => void;
  /** Stop a running session. */
  onStopSession: (sessionKey: string) => void;
  /**
   * Attach a session that has no canvas node yet (e.g. one launched from the
   * mobile view) by creating a leader node bound to its sessionKey and
   * revealing it on the canvas.
   */
  onAttachToCanvas: (sessionKey: string) => void;
}

interface LeaderNodeRef {
  nodeId: string;
  data: LeaderData;
}

function formatCost(cost: number | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "$0.00";
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Build a sessionKey → leader-node lookup so cards can offer node actions. */
function buildLeaderNodeIndex(nodes: CanvasNode[]): Map<string, LeaderNodeRef> {
  const index = new Map<string, LeaderNodeRef>();
  for (const node of nodes) {
    if (node.type !== "leader") continue;
    const data = node.data as LeaderData;
    if (data.sessionKey) {
      index.set(data.sessionKey, { nodeId: node.id, data });
    }
  }
  return index;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`act-pill act-pill--${status}`}>{status}</span>;
}

function SessionCard({
  session,
  selected,
  onCanvas,
  onSelect,
}: {
  session: MobileSessionInfo;
  selected: boolean;
  onCanvas: boolean;
  onSelect: () => void;
}) {
  const classes = [
    "act-card",
    selected && "act-card--selected",
    needsAttention(session) && "act-card--attention",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} type="button" onClick={onSelect} aria-pressed={selected}>
      <span className="act-card-top">
        <span className="act-card-role">{sessionRoleLabel(session)}</span>
        <StatusPill status={session.status} />
      </span>
      <span className="act-card-title">{sessionDisplayTitle(session)}</span>
      <span className="act-card-meta">
        {formatCost(session.totalCost)} · {session.turns ?? 0} turns
        {session.model ? ` · ${session.model}` : ""}
      </span>
      <span className="act-card-activity">
        {session.lastActivity || session.cwd || session.sessionKey}
      </span>
      <span className="act-card-foot">
        {session.lastActivityAt ? <span>{timeAgo(session.lastActivityAt)}</span> : <span />}
        {onCanvas && <span className="act-card-oncanvas">on canvas</span>}
      </span>
    </button>
  );
}

function Inspector({
  session,
  leader,
  onClose,
  onOpenInCanvas,
  onExpandFullscreen,
  onStopSession,
  onAttachToCanvas,
}: {
  session: MobileSessionInfo;
  leader: LeaderNodeRef | undefined;
  onClose: () => void;
  onOpenInCanvas: (nodeId: string) => void;
  onExpandFullscreen: (nodeId: string) => void;
  onStopSession: (sessionKey: string) => void;
  onAttachToCanvas: (sessionKey: string) => void;
}) {
  const isRunning = session.status === "running" || session.status === "creating";

  return (
    <aside className="act-inspector" aria-label="Session details">
      <div className="act-inspector-head">
        <span className="act-inspector-title">{sessionDisplayTitle(session)}</span>
        <button className="act-icon-btn" type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>

      <div className="act-inspector-statusrow">
        <span className="act-card-role">{sessionRoleLabel(session)}</span>
        <StatusPill status={session.status} />
      </div>

      <dl className="act-metrics">
        <div className="act-metric">
          <dt>Cost</dt>
          <dd>{formatCost(session.totalCost)}</dd>
        </div>
        <div className="act-metric">
          <dt>Turns</dt>
          <dd>{session.turns ?? 0}</dd>
        </div>
        <div className="act-metric">
          <dt>Model</dt>
          <dd title={session.model ?? ""}>{session.model ?? "—"}</dd>
        </div>
        <div className="act-metric">
          <dt>Harness</dt>
          <dd>{session.harness ?? "—"}</dd>
        </div>
      </dl>

      <div className="act-actions">
        {leader ? (
          <>
            <button
              className="act-btn"
              type="button"
              onClick={() => onOpenInCanvas(leader.nodeId)}
            >
              Open in Canvas
            </button>
            <button
              className="act-btn act-btn--primary"
              type="button"
              onClick={() => onExpandFullscreen(leader.nodeId)}
            >
              Expand fullscreen
            </button>
          </>
        ) : (
          <button
            className="act-btn act-btn--primary"
            type="button"
            onClick={() => onAttachToCanvas(session.sessionKey)}
          >
            Attach to canvas
          </button>
        )}
        <button
          className="act-btn act-btn--danger"
          type="button"
          disabled={!isRunning}
          onClick={() => onStopSession(session.sessionKey)}
        >
          Stop
        </button>
      </div>

      <div className="act-inspector-section">
        <div className="act-inspector-label">Conversation</div>
        {leader ? (
          <SessionTranscript
            messages={leader.data.messages}
            streamingText={leader.data.streamingText ?? ""}
          />
        ) : (
          <div className="act-inspector-fallback">
            <p>
              This session isn't on the canvas yet. Use <strong>Attach to canvas</strong> to
              place it on the board and load its live transcript.
            </p>
            {session.lastActivity && <p className="act-inspector-lastactivity">{session.lastActivity}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

export function ActivityView({
  sessions,
  nodes,
  onLaunchLeader,
  onOpenInCanvas,
  onExpandFullscreen,
  onStopSession,
  onAttachToCanvas,
}: ActivityViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Top-level surface only — minions are managed by their leader (mirrors mobile).
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.role !== "minion"),
    [sessions],
  );
  const sections = useMemo(() => groupSessionsByActivity(visibleSessions), [visibleSessions]);
  const leaderIndex = useMemo(() => buildLeaderNodeIndex(nodes), [nodes]);

  const selectedSession = useMemo(
    () => visibleSessions.find((s) => s.sessionKey === selectedKey) ?? null,
    [visibleSessions, selectedKey],
  );

  // If the selected session disappears (cleared/ended off the list), drop the
  // inspector rather than leaving a dangling selection.
  useEffect(() => {
    if (selectedKey && !visibleSessions.some((s) => s.sessionKey === selectedKey)) {
      setSelectedKey(null);
    }
  }, [selectedKey, visibleSessions]);

  return (
    <div className="act-root">
      <div className="act-main">
        <header className="act-header">
          <div className="act-header-main">
            <h1 className="act-header-title">Activity</h1>
            <span className="act-header-count">{visibleSessions.length}</span>
          </div>
          <button
            className="act-launch-btn"
            type="button"
            onClick={onLaunchLeader}
            aria-label="Launch leader"
          >
            <svg width="14" height="14" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="rgba(255,255,255,0.25)"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M12 24L10 16L16 20L20 14L24 20L30 16L28 24H12Z"
                fill="currentColor"
              />
              <circle cx="20" cy="28" r="2" fill="currentColor" />
            </svg>
            <span>Launch</span>
          </button>
        </header>

        {visibleSessions.length === 0 ? (
          <div className="act-empty">
            <p className="act-empty-title">No sessions yet</p>
            <p className="act-empty-sub">Launch a leader to start from the canvas.</p>
            <button
              className="act-btn act-btn--primary act-empty-launch"
              type="button"
              onClick={onLaunchLeader}
            >
              Launch
            </button>
          </div>
        ) : (
          sections.map((section) => (
            <section className="act-section" key={section.id} aria-label={section.title}>
              <h2 className="act-section-head">
                <span>{section.title}</span>
                <span className="act-section-count">{section.sessions.length}</span>
              </h2>
              <div className="act-grid">
                {section.sessions.map((session) => (
                  <SessionCard
                    key={session.sessionKey}
                    session={session}
                    selected={session.sessionKey === selectedKey}
                    onCanvas={leaderIndex.has(session.sessionKey)}
                    onSelect={() => setSelectedKey(session.sessionKey)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {selectedSession && (
        <Inspector
          session={selectedSession}
          leader={leaderIndex.get(selectedSession.sessionKey)}
          onClose={() => setSelectedKey(null)}
          onOpenInCanvas={onOpenInCanvas}
          onExpandFullscreen={onExpandFullscreen}
          onStopSession={onStopSession}
          onAttachToCanvas={onAttachToCanvas}
        />
      )}
    </div>
  );
}
