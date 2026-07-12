import { useEffect, useMemo, useState } from "react";

import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import {
  groupSessionsForTriage,
  isVisibleInActivity,
  compareActivityPriority,
  type ActivityVisibility,
  needsAttention,
  sessionDisplayTitle,
  sessionRoleLabel,
} from "./mobile/mobile-selectors.ts";
import { timeAgo } from "./nodes/leader-message-helpers.ts";
import { SessionTranscript } from "./components/SessionTranscript.tsx";
import { GitCompare } from "lucide-react";
import {
  SessionChangesPanel,
  leaderHasReviewableChanges,
} from "./ChangesView.tsx";
import type { SocketSubscribe } from "./use-socket.ts";
import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import { DashboardSurface } from "./nodes/render/DashboardSurface.tsx";
import { LeaderNodeRenderer } from "./nodes/LeaderNode.tsx";
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
  onLaunchLeader: () => string | void;
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
  /** WS send — used by the inline worktree review panel. */
  socketSend?: ((data: unknown) => void) | undefined;
  /** WS subscribe — used by the inline worktree review panel. */
  socketSubscribe?: SocketSubscribe | undefined;
  /** Project working directory used when the embedded leader starts. */
  projectPath?: string | undefined;
  /** Update a leader node's data (e.g. after a merge is requested). */
  onUpdateNodeData: (nodeId: string, data: LeaderData) => void;
  workItemRuns?: Record<string, WorkItemRunSnapshot[]>;
  runNextCursor?: Record<string, string | null>;
  onLoadRuns?: (workItemId: string, cursor?: string) => void;
}

interface LeaderNodeRef {
  nodeId: string;
  data: LeaderData;
}

type ActivitySession = MobileSessionInfo & {
  reviewableChanges?: boolean;
};

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

function attentionKind(session: ActivitySession): "error" | "waiting" | "changes" {
  if (session.reviewLifecycle?.reviewState === "error_to_review" ||
      session.reviewLifecycle?.reviewState === "interrupted_to_review") return "error";
  if (session.reviewLifecycle?.reviewState === "decision_needed") return "waiting";
  if (session.status === "error") return "error";
  if (session.status === "waiting" || session.pendingAttention === true) return "waiting";
  return "changes";
}

function attentionReason(session: ActivitySession): string {
  const lifecycle = session.reviewLifecycle;
  if (lifecycle?.acknowledgedAt) return "acknowledged";
  if (lifecycle?.reviewState === "completion_to_review") return "complete · read report";
  if (lifecycle?.reviewState === "interrupted_to_review") return "interrupted";
  if (lifecycle?.reviewState === "decision_needed") return "decision needed";
  if (lifecycle?.reviewState === "error_to_review") return "error";
  switch (attentionKind(session)) {
    case "error":
      return "errored";
    case "waiting":
      return "waiting for you";
    case "changes":
      return "changes ready";
  }
}

function attentionAction(session: ActivitySession): string {
  const reviewState = session.reviewLifecycle?.reviewState;
  if (reviewState === "completion_to_review") return "Read";
  if (reviewState === "interrupted_to_review") return "Inspect";
  if (reviewState === "decision_needed") return "Reply";
  switch (attentionKind(session)) {
    case "error":
      return "Open";
    case "waiting":
      return "Reply";
    case "changes":
      return "Review";
  }
}

function SessionTriageRow({
  session,
  selected,
  onCanvas,
  onSelect,
}: {
  session: ActivitySession;
  selected: boolean;
  onCanvas: boolean;
  onSelect: () => void;
}) {
  const kind = attentionKind(session);
  const classes = [
    "act-triage-row",
    `act-triage-row--${kind}`,
    selected && "act-triage-row--selected",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <button
        className="act-triage-main"
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className={`act-triage-icon act-triage-icon--${kind}`} aria-hidden>
          {kind === "error" ? "!" : kind === "waiting" ? "?" : <GitCompare size={15} />}
        </span>
        <span className="act-triage-body">
          <span className="act-triage-line">
            <span className="act-triage-title">{sessionDisplayTitle(session)}</span>
            <span className={`act-triage-reason act-triage-reason--${kind}`}>
              {attentionReason(session)}
            </span>
          </span>
          <span className="act-triage-sub">
            {sessionRoleLabel(session).toUpperCase()} · {formatCost(session.totalCost)} ·{" "}
            {session.turns ?? 0} turns
            {session.lastActivity ? ` · ${session.lastActivity}` : ""}
            {session.lastActivityAt ? ` · ${timeAgo(session.lastActivityAt)}` : ""}
          </span>
        </span>
      </button>
      <span className="act-triage-actions">
        <button className="act-mini-btn act-mini-btn--primary" type="button" onClick={onSelect}>
          {attentionAction(session)}
        </button>
        {onCanvas && (
          <button className="act-mini-btn" type="button" onClick={onSelect}>
            Open
          </button>
        )}
      </span>
    </div>
  );
}

function SessionCard({
  session,
  selected,
  onCanvas,
  hasChanges,
  onSelect,
}: {
  session: ActivitySession;
  selected: boolean;
  onCanvas: boolean;
  hasChanges: boolean;
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
        <span className="act-card-foot-tags">
          {hasChanges && (
            <span className="act-card-changes">
              <GitCompare size={9} strokeWidth={2.5} aria-hidden /> changes
            </span>
          )}
          {onCanvas && <span className="act-card-oncanvas">on canvas</span>}
        </span>
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
  socketSend,
  socketSubscribe,
  onUpdateNodeData,
  onAcknowledge,
  onDismiss,
  onReopen,
  runs = [], runNextCursor, onLoadRuns,
}: {
  session: MobileSessionInfo;
  leader: LeaderNodeRef | undefined;
  onClose: () => void;
  onOpenInCanvas: (nodeId: string) => void;
  onExpandFullscreen: (nodeId: string) => void;
  onStopSession: (sessionKey: string) => void;
  onAttachToCanvas: (sessionKey: string) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
  onUpdateNodeData: (nodeId: string, data: LeaderData) => void;
  onAcknowledge: () => void;
  onDismiss: () => void;
  onReopen: () => void;
  runs?: WorkItemRunSnapshot[];
  runNextCursor?: string | null;
  onLoadRuns?: (cursor?: string) => void;
}) {
  const isRunning = session.status === "running" || session.status === "creating";
  const showChanges = !!leader && leaderHasReviewableChanges(leader.data);
  const [reply, setReply] = useState("");
  const submitReply = () => {
    const prompt = reply.trim();
    const blockedCanonicalWait = Boolean(session.workItemId && session.status === "waiting"
      && session.reviewLifecycle?.reviewState !== "decision_needed");
    if (!prompt || !socketSend || blockedCanonicalWait) return;
    socketSend(session.workItemId ? {
      type: session.status === "waiting" && session.reviewLifecycle?.reviewState === "decision_needed"
        ? "reply_to_waiting_run" : "start_work_item_run",
      requestId: crypto.randomUUID(), workItemId: session.workItemId,
      ...(session.status === "waiting" && session.reviewLifecycle?.reviewState === "decision_needed"
        ? { runKey: session.sessionKey } : {}), prompt,
      expectedLifecycleRevision: session.reviewLifecycle?.lifecycleRevision ?? 0,
      expectedCurrentRunKey: session.sessionKey.startsWith("work-item:") ? null : session.sessionKey,
    } : { type: "send_message", sessionKey: session.sessionKey, prompt });
    setReply("");
  };

  return (
    <aside className="act-inspector" aria-label="Session details">
      {session.reviewLifecycle && session.reviewLifecycle.reviewState !== "none" &&
        session.reviewLifecycle.acknowledgedAt == null && (
          <div className={`act-review-banner act-review-banner--${attentionKind(session)}`}>
            <span className="act-review-banner-label">{attentionReason(session)}</span>
            <span>{session.reviewLifecycle.reviewReason}</span>
          </div>
        )}
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
        {session.reviewLifecycle && session.reviewLifecycle.reviewState !== "none" &&
          session.reviewLifecycle.acknowledgedAt == null &&
          session.reviewLifecycle.dismissedAt == null && (
            <button className="act-btn act-btn--primary" type="button" onClick={onAcknowledge}>
              Mark reviewed
            </button>
          )}
        {session.reviewLifecycle?.dismissedAt == null ? (
          <button className="act-btn" type="button" onClick={onDismiss}>Dismiss</button>
        ) : (
          <button className="act-btn" type="button" onClick={onReopen}>Restore</button>
        )}
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

      {showChanges && leader && (
        <div className="act-inspector-section">
          <div className="act-inspector-label">
            <GitCompare size={12} strokeWidth={2} aria-hidden /> Changes
          </div>
          <SessionChangesPanel
            nodeId={leader.nodeId}
            sessionKey={session.sessionKey}
            data={leader.data}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            onUpdateNodeData={onUpdateNodeData}
            onOpenInCanvas={onOpenInCanvas}
          />
        </div>
      )}

      {session.reviewLifecycle?.finalReport && (
        <div className="act-inspector-section">
          <div className="act-inspector-label">Final report</div>
          <div className="act-final-report">{session.reviewLifecycle.finalReport}</div>
        </div>
      )}

      {session.workItemId && (
        <details className="act-inspector-section" onToggle={(event) => {
          if (event.currentTarget.open && runs.length === 0) onLoadRuns?.();
        }}>
          <summary className="act-inspector-label">Run history</summary>
          {runs.length === 0 ? <p>No prior runs loaded.</p> : (
            <ol aria-label="Run history">
              {runs.map((run) => <li key={run.runKey}>
                <strong>Iteration {run.runNumber ?? "child"}</strong> · {run.outcome}
                {run.endedAt ? ` · ${new Date(run.endedAt).toLocaleString()}` : " · active"}
                {run.finalReport ? <p>{run.finalReport}</p> : null}
              </li>)}
            </ol>
          )}
          {runNextCursor ? <button type="button" onClick={() => onLoadRuns?.(runNextCursor)}>Load more</button> : null}
        </details>
      )}

      {session.renderState && session.renderState.components.length > 0 && (
        <div className="act-inspector-section act-dashboard-section">
          <div className="act-inspector-label">Dashboard</div>
          <div className="act-dashboard-frame">
            <DashboardSurface
              renderState={session.renderState}
              onSubmitForm={(formComponentId, formAnswers) => socketSend?.({
                type: "submit_form",
                sessionKey: session.sessionKey,
                formComponentId,
                formAnswers,
              })}
            />
          </div>
        </div>
      )}

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
      <div className="act-composer">
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitReply();
            }
          }}
          placeholder="Reply or steer this agent…"
          aria-label="Reply or steer this agent"
        />
        <button type="button" onClick={submitReply} disabled={!reply.trim() || !socketSend
          || Boolean(session.workItemId && session.status === "waiting"
            && session.reviewLifecycle?.reviewState !== "decision_needed")}>
          Send
        </button>
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
  socketSend,
  socketSubscribe,
  projectPath,
  onUpdateNodeData,
  workItemRuns = {}, runNextCursor = {}, onLoadRuns,
}: ActivityViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<ActivityVisibility>("open");
  const [launchNodeId, setLaunchNodeId] = useState<string | null>(null);

  // Top-level surface only — minions are managed by their leader (mirrors mobile).
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.role !== "minion"),
    [sessions],
  );
  const leaderIndex = useMemo(() => buildLeaderNodeIndex(nodes), [nodes]);
  const launchNode = launchNodeId
    ? nodes.find((node) => node.id === launchNodeId && node.type === "leader")
    : undefined;

  useEffect(() => {
    if (!launchNode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLaunchNodeId(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [launchNode]);

  function openLaunchExperience() {
    const nodeId = onLaunchLeader();
    if (typeof nodeId === "string") setLaunchNodeId(nodeId);
  }
  const allActivitySessions = useMemo<ActivitySession[]>(
    () =>
      visibleSessions.map((session) => {
        const leader = leaderIndex.get(session.sessionKey);
        const reviewableChanges = !!leader && leaderHasReviewableChanges(leader.data);
        if (session.reviewableChanges === reviewableChanges) return session;
        return { ...session, reviewableChanges };
      }),
    [leaderIndex, visibleSessions],
  );
  const activitySessions = useMemo(
    () => allActivitySessions
      .filter((session) => isVisibleInActivity(session, visibility))
      .sort(compareActivityPriority),
    [allActivitySessions, visibility],
  );
  const triage = useMemo(() => groupSessionsForTriage(activitySessions), [activitySessions]);
  const workingCount = activitySessions.filter((session) =>
    session.status === "running" || session.status === "creating",
  ).length;
  const waitingCount = activitySessions.filter((session) =>
    session.status === "waiting" || session.reviewLifecycle?.reviewState === "decision_needed",
  ).length;

  const selectedSession = useMemo(
    () => activitySessions.find((s) => s.sessionKey === selectedKey) ?? null,
    [activitySessions, selectedKey],
  );

  // If the selected session disappears (cleared/ended off the list), drop the
  // inspector rather than leaving a dangling selection.
  useEffect(() => {
    if (selectedKey && !activitySessions.some((s) => s.sessionKey === selectedKey)) {
      setSelectedKey(null);
    }
  }, [activitySessions, selectedKey]);

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
            onClick={openLaunchExperience}
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
        <div className="act-summary" aria-label="Activity summary">
          <div className="act-summary-item act-summary-item--attention">
            <strong>{triage.needsYou.length}</strong><span>to review</span>
          </div>
          <div className="act-summary-item"><strong>{workingCount}</strong><span>working</span></div>
          <div className="act-summary-item"><strong>{waitingCount}</strong><span>waiting</span></div>
        </div>
        <div className="act-filters" aria-label="Activity visibility">
          {(["open", "all", "dismissed"] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={`act-filter${visibility === id ? " act-filter--active" : ""}`}
              onClick={() => setVisibility(id)}
            >
              {id === "open" ? "Open" : id === "all" ? "All" : "Dismissed"}
            </button>
          ))}
        </div>

        {visibleSessions.length === 0 ? (
          <div className="act-empty">
            <p className="act-empty-title">No sessions yet</p>
            <p className="act-empty-sub">Launch a leader to start from the canvas.</p>
            <button
              className="act-btn act-btn--primary act-empty-launch"
              type="button"
              onClick={openLaunchExperience}
            >
              Launch
            </button>
          </div>
        ) : (
          <>
            {triage.needsYou.length > 0 && (
              <section className="act-section act-section--triage" aria-label="Needs you">
                <h2 className="act-section-head">
                  <span>Needs you</span>
                  <span className="act-section-count">{triage.needsYou.length}</span>
                </h2>
                <div className="act-triage-list">
                  {triage.needsYou.map((session) => (
                    <SessionTriageRow
                      key={session.sessionKey}
                      session={session}
                      selected={session.sessionKey === selectedKey}
                      onCanvas={leaderIndex.has(session.sessionKey)}
                      onSelect={() => setSelectedKey(session.sessionKey)}
                    />
                  ))}
                </div>
              </section>
            )}

            {triage.sections.map((section) => (
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
                      hasChanges={session.reviewableChanges === true}
                      onSelect={() => setSelectedKey(session.sessionKey)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      {!selectedSession && activitySessions.length > 0 && (
        <div className="act-workspace-empty" aria-label="Activity workspace">
          <div>
            <span className="act-workspace-empty-icon" aria-hidden>↗</span>
            <h2>Select a session</h2>
            <p>Read its latest report, inspect the dashboard, reply, review changes, or manage the run.</p>
          </div>
        </div>
      )}

      {selectedSession && (
        <Inspector
          session={selectedSession}
          leader={leaderIndex.get(selectedSession.sessionKey)}
          onClose={() => setSelectedKey(null)}
          onOpenInCanvas={onOpenInCanvas}
          onExpandFullscreen={onExpandFullscreen}
          onStopSession={onStopSession}
          onAttachToCanvas={onAttachToCanvas}
          socketSend={socketSend}
          socketSubscribe={socketSubscribe}
          onUpdateNodeData={onUpdateNodeData}
          onAcknowledge={() => socketSend?.({
            type: selectedSession.workItemId ? "review_work_item" : "acknowledge_session",
            ...(selectedSession.workItemId ? { workItemId: selectedSession.workItemId,
              requestId: crypto.randomUUID(), expectedCurrentRunKey: selectedSession.sessionKey.startsWith("work-item:") ? null : selectedSession.sessionKey }
              : { sessionKey: selectedSession.sessionKey }),
            expectedLifecycleRevision: selectedSession.reviewLifecycle?.lifecycleRevision ?? 0,
          })}
          onDismiss={() => socketSend?.({
            type: selectedSession.workItemId ? "archive_work_item" : "dismiss_session",
            ...(selectedSession.workItemId ? { workItemId: selectedSession.workItemId,
              requestId: crypto.randomUUID(), expectedCurrentRunKey: selectedSession.sessionKey.startsWith("work-item:") ? null : selectedSession.sessionKey }
              : { sessionKey: selectedSession.sessionKey }),
            expectedLifecycleRevision: selectedSession.reviewLifecycle?.lifecycleRevision ?? 0,
          })}
          onReopen={() => socketSend?.({
            type: selectedSession.workItemId ? "restore_work_item" : "reopen_session",
            ...(selectedSession.workItemId ? { workItemId: selectedSession.workItemId,
              requestId: crypto.randomUUID(), expectedCurrentRunKey: selectedSession.sessionKey.startsWith("work-item:") ? null : selectedSession.sessionKey }
              : { sessionKey: selectedSession.sessionKey }),
            expectedLifecycleRevision: selectedSession.reviewLifecycle?.lifecycleRevision ?? 0,
          })}
          runs={selectedSession.workItemId ? workItemRuns[selectedSession.workItemId] ?? [] : []}
          runNextCursor={selectedSession.workItemId ? runNextCursor[selectedSession.workItemId] ?? null : null}
          {...(selectedSession.workItemId && onLoadRuns
            ? { onLoadRuns: (cursor?: string) => onLoadRuns(selectedSession.workItemId!, cursor) }
            : {})}
        />
      )}

      {launchNode && (
        <div
          className="act-launch-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLaunchNodeId(null);
          }}
        >
          <section
            className="act-launch-experience"
            role="dialog"
            aria-modal="true"
            aria-label="Launch leader"
          >
            <header className="act-launch-head">
              <div>
                <span className="act-launch-eyebrow">New canvas leader</span>
                <h2 id="activity-launch-title">What should your leader do?</h2>
                <p>Start with the goal. Add a model, permissions, or skills only when you need them.</p>
              </div>
              <button className="act-launch-close" type="button" onClick={() => setLaunchNodeId(null)} aria-label="Close launch">
                <span aria-hidden>×</span>
              </button>
            </header>
            <div className="act-launch-leader">
              <LeaderNodeRenderer
                node={launchNode}
                launchMode
                isSelected
                onUpdateData={(data) => onUpdateNodeData(launchNode.id, data as LeaderData)}
                socketSend={socketSend}
                socketSubscribe={socketSubscribe}
                projectPath={projectPath}
              />
            </div>
            <footer className="act-launch-foot">
              <span><strong>Saved to canvas</strong> · You can close this panel without losing the draft.</span>
              <button type="button" onClick={() => onOpenInCanvas(launchNode.id)}>Open on canvas</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
