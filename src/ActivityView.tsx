import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import {
  groupSessionsForTriage,
  isVisibleInActivity,
  compareActivityPriority,
  type ActivityVisibility,
  needsAttention,
  attentionKind,
  attentionReason,
  attentionAction,
  sessionDisplayTitle,
  sessionRoleLabel,
} from "./mobile/mobile-selectors.ts";
import {
  buildLifecycleCommand,
  canAcknowledge,
  isDismissed,
  type LifecycleAction,
} from "./mobile/mobile-activity-actions.ts";
import { timeAgo } from "./nodes/leader-message-helpers.ts";
import { SessionTranscript } from "./components/SessionTranscript.tsx";
import { Check, GitCompare, RotateCcw, X } from "lucide-react";
import {
  SessionChangesPanel,
  leaderHasReviewableChanges,
} from "./ChangesView.tsx";
import type { SocketSubscribe } from "./use-socket.ts";
import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import { DashboardSurface } from "./nodes/render/DashboardSurface.tsx";
import { LeaderNodeRenderer } from "./nodes/LeaderNode.tsx";
import { ActivityEmptyState } from "./ActivityEmptyState.tsx";
import { ActivitySessionHome } from "./ActivitySessionHome.tsx";
import { selectRecentAgentWork } from "./activity-recent-work.ts";
import { randomUuid } from "./random-id.ts";
import type { PromptFailure } from "./use-work-items.ts";
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
  /** Remove an Activity-created draft when launch is cancelled before start. */
  onCancelLaunchLeader: (nodeId: string) => void;
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
  /** Canonical prompt path; false preserves input while the item is loading. */
  onPromptWorkItem?: (workItemId: string, prompt: string) => boolean | void;
  promptFailures?: Record<string, PromptFailure>;
  onClearPromptFailure?: (workItemId: string) => void;
}

interface LeaderNodeRef {
  nodeId: string;
  data: LeaderData;
}

type ActivitySession = MobileSessionInfo & {
  reviewableChanges?: boolean;
};

type ActivitySummaryFilter = "needs-you" | "working" | "waiting";

/**
 * The command names whose server responses the Activity view surfaces inline.
 * A rejected lifecycle mutation (revision conflict, invalid transition, missing
 * session) previously vanished silently, making the Check/X/bulk controls look
 * dead — any failure now lands in a visible banner.
 */
const LIFECYCLE_COMMANDS = new Set([
  "review_work_item",
  "archive_work_item",
  "restore_work_item",
  "acknowledge_session",
  "dismiss_session",
  "reopen_session",
]);

/** Extract a user-facing error from a lifecycle command response, or null. */
export function lifecycleActionError(msg: unknown): { failed: boolean; error: string } | null {
  const m = msg as {
    type?: unknown; command?: unknown; success?: unknown; error?: unknown;
  };
  if (m.type !== "work_item_response" && m.type !== "control_response") return null;
  if (typeof m.command !== "string" || !LIFECYCLE_COMMANDS.has(m.command)) return null;
  if (m.success !== false) return { failed: false, error: "" };
  const detail = typeof m.error === "string" && m.error.trim()
    ? m.error
    : "The server rejected the action.";
  const verb = m.command.startsWith("review") || m.command.startsWith("acknowledge")
    ? "Mark reviewed"
    : m.command.startsWith("archive") || m.command.startsWith("dismiss")
      ? "Dismiss"
      : "Restore";
  return { failed: true, error: `${verb} failed: ${detail}` };
}

function matchesSummaryFilter(
  session: ActivitySession,
  filter: ActivitySummaryFilter,
): boolean {
  switch (filter) {
    case "needs-you":
      return needsAttention(session);
    case "working":
      return session.status === "running" || session.status === "creating";
    case "waiting":
      return session.status === "waiting" ||
        session.reviewLifecycle?.reviewState === "decision_needed";
  }
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

/** A checkbox that toggles a session's membership in the bulk-selection set. */
function SelectBox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <label className="act-select" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Select ${label}`}
      />
    </label>
  );
}

/**
 * The immediate review/dismiss controls shared by every list row and card, so
 * a session can be resolved without opening the inspector. Buttons are rendered
 * only when the lifecycle transition applies to the session's current state.
 */
function LifecycleActions({
  session,
  onAction,
  className,
}: {
  session: ActivitySession;
  onAction: (action: LifecycleAction, session: ActivitySession) => void;
  className?: string;
}) {
  const dismissed = isDismissed(session);
  const act = (action: LifecycleAction) => (event: MouseEvent) => {
    event.stopPropagation();
    onAction(action, session);
  };
  return (
    <span className={className ?? "act-life-actions"}>
      {canAcknowledge(session) && (
        <button
          className="act-icon-action act-icon-action--review"
          type="button"
          onClick={act("acknowledge")}
          aria-label="Mark reviewed"
          title="Mark reviewed"
        >
          <Check size={14} strokeWidth={2.5} aria-hidden />
        </button>
      )}
      {dismissed ? (
        <button
          className="act-icon-action"
          type="button"
          onClick={act("reopen")}
          aria-label="Restore"
          title="Restore"
        >
          <RotateCcw size={13} strokeWidth={2.25} aria-hidden />
        </button>
      ) : (
        <button
          className="act-icon-action act-icon-action--dismiss"
          type="button"
          onClick={act("dismiss")}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={14} strokeWidth={2.25} aria-hidden />
        </button>
      )}
    </span>
  );
}

function SessionTriageRow({
  session,
  selected,
  checked,
  onSelect,
  onToggleSelect,
  onAction,
}: {
  session: ActivitySession;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onAction: (action: LifecycleAction, session: ActivitySession) => void;
}) {
  const kind = attentionKind(session);
  const classes = [
    "act-triage-row",
    `act-triage-row--${kind}`,
    selected && "act-triage-row--selected",
    checked && "act-triage-row--checked",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <SelectBox
        checked={checked}
        label={sessionDisplayTitle(session)}
        onToggle={onToggleSelect}
      />
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
          </span>
          <span className="act-triage-sub">
            <span className={`act-triage-reason act-triage-reason--${kind}`}>
              {attentionReason(session)}
            </span>
            <span className="act-triage-meta">
              {sessionRoleLabel(session).toUpperCase()} · {formatCost(session.totalCost)} ·{" "}
              {session.turns ?? 0} turns
              {session.lastActivityAt ? ` · ${timeAgo(session.lastActivityAt)}` : ""}
            </span>
          </span>
        </span>
      </button>
      <span className="act-triage-actions">
        <button
          className="act-mini-btn act-mini-btn--primary act-mini-btn--open"
          type="button"
          onClick={onSelect}
        >
          {attentionAction(session)}
        </button>
        <LifecycleActions session={session} onAction={onAction} />
      </span>
    </div>
  );
}

function SessionCard({
  session,
  selected,
  checked,
  onCanvas,
  hasChanges,
  onSelect,
  onToggleSelect,
  onAction,
}: {
  session: ActivitySession;
  selected: boolean;
  checked: boolean;
  onCanvas: boolean;
  hasChanges: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onAction: (action: LifecycleAction, session: ActivitySession) => void;
}) {
  const classes = [
    "act-card",
    selected && "act-card--selected",
    checked && "act-card--checked",
    needsAttention(session) && "act-card--attention",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <SelectBox
        checked={checked}
        label={sessionDisplayTitle(session)}
        onToggle={onToggleSelect}
      />
      <button className="act-card-main" type="button" onClick={onSelect} aria-pressed={selected}>
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
      <LifecycleActions session={session} onAction={onAction} className="act-card-actions" />
    </div>
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
  onPromptWorkItem,
  promptFailure,
  onClearPromptFailure,
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
  onPromptWorkItem?: (workItemId: string, prompt: string) => boolean | void;
  promptFailure?: PromptFailure;
  onClearPromptFailure?: () => void;
  runs?: WorkItemRunSnapshot[];
  runNextCursor?: string | null;
  onLoadRuns?: (cursor?: string) => void;
}) {
  const isRunning = session.status === "running" || session.status === "creating";
  const showChanges = !!leader && leaderHasReviewableChanges(leader.data);
  const [reply, setReply] = useState("");
  useEffect(() => {
    if (promptFailure) setReply(promptFailure.prompt);
  }, [promptFailure]);
  const submitReply = () => {
    const prompt = reply.trim();
    // Only canonical entries carry the work item's revision counter; a session
    // that merely references a work item must use the session envelope or the
    // server rejects the mutation as a stale work-item lifecycle.
    const canonical = Boolean(session.workItemId && session.canonicalWorkItem);
    const blockedCanonicalWait = Boolean(canonical && session.status === "waiting"
      && session.reviewLifecycle?.reviewState !== "decision_needed");
    if (!prompt || !socketSend || blockedCanonicalWait) return;
    if (session.workItemId && onPromptWorkItem) {
      if (onPromptWorkItem(session.workItemId, prompt) !== false) setReply("");
      return;
    }
    socketSend(canonical ? {
      type: "continue_work_item",
      requestId: randomUuid(), workItemId: session.workItemId, prompt,
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
      {promptFailure && (
        <div className="act-action-error" role="alert">
          <span>{promptFailure.error}</span>
          <button className="act-icon-btn" type="button" onClick={onClearPromptFailure}
            aria-label="Dismiss prompt error">×</button>
        </div>
      )}
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
  onCancelLaunchLeader,
  onOpenInCanvas,
  onExpandFullscreen,
  onStopSession,
  onAttachToCanvas,
  socketSend,
  socketSubscribe,
  projectPath,
  onUpdateNodeData,
  workItemRuns = {}, runNextCursor = {}, onLoadRuns, onPromptWorkItem,
  promptFailures = {}, onClearPromptFailure,
}: ActivityViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<ActivityVisibility>("open");
  const [summaryFilter, setSummaryFilter] = useState<ActivitySummaryFilter | null>(null);
  const [launchNodeId, setLaunchNodeId] = useState<string | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  // Surface rejected lifecycle mutations (revision conflicts, invalid
  // transitions) instead of swallowing them; a later success clears the banner.
  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe("*", (msg: unknown) => {
      const outcome = lifecycleActionError(msg);
      if (!outcome) return;
      setActionError(outcome.failed ? outcome.error : null);
    });
  }, [socketSubscribe]);

  const toggleChecked = (sessionKey: string) =>
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });

  const sendLifecycle = (action: LifecycleAction, session: MobileSessionInfo) => {
    socketSend?.(buildLifecycleCommand(action, session, randomUuid()));
  };

  // Top-level surface only — minions are managed by their leader (mirrors mobile).
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.role !== "minion"),
    [sessions],
  );
  const leaderIndex = useMemo(() => buildLeaderNodeIndex(nodes), [nodes]);
  const launchNode = launchNodeId
    ? nodes.find((node) => node.id === launchNodeId && node.type === "leader")
    : undefined;

  function openLaunchExperience() {
    if (launchNodeId) return;
    const nodeId = onLaunchLeader();
    if (typeof nodeId === "string") {
      setSelectedKey(null);
      setLaunchNodeId(nodeId);
    }
  }

  function closeLaunchExperience() {
    if (!launchNode) return;
    if (!(launchNode.data as LeaderData).sessionKey) {
      onCancelLaunchLeader(launchNode.id);
    }
    setLaunchNodeId(null);
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
  const visibilitySessions = useMemo(
    () => allActivitySessions
      .filter((session) => isVisibleInActivity(session, visibility))
      .sort(compareActivityPriority),
    [allActivitySessions, visibility],
  );
  const activitySessions = useMemo(
    () => summaryFilter
      ? visibilitySessions.filter((session) => matchesSummaryFilter(session, summaryFilter))
      : visibilitySessions,
    [summaryFilter, visibilitySessions],
  );
  const triage = useMemo(() => groupSessionsForTriage(activitySessions), [activitySessions]);
  const summaryItems: Array<{
    id: ActivitySummaryFilter;
    label: string;
    count: number;
    attention?: boolean;
  }> = [
    {
      id: "needs-you",
      label: "to review",
      count: visibilitySessions.filter((session) => needsAttention(session)).length,
      attention: true,
    },
    {
      id: "working",
      label: "working",
      count: visibilitySessions.filter((session) => matchesSummaryFilter(session, "working")).length,
    },
    {
      id: "waiting",
      label: "waiting",
      count: visibilitySessions.filter((session) => matchesSummaryFilter(session, "waiting")).length,
    },
  ];

  const selectedSession = useMemo(
    () => activitySessions.find((s) => s.sessionKey === selectedKey) ?? null,
    [activitySessions, selectedKey],
  );

  // ── Empty-state launchpad ────────────────────────────────────────────────
  // Both empty states embed the full launch composer inline plus a preview of
  // the most recent agents' work. The composer needs a draft leader node, so
  // entering an empty state auto-creates one (guarded to a single attempt per
  // entry); leaving the empty state or this view cancels an auto-created
  // draft that was never launched, so no orphan nodes land on the canvas.
  const emptyStateActive = visibleSessions.length === 0 || activitySessions.length === 0;
  const recentWork = useMemo(
    () => selectRecentAgentWork(sessions, nodes.filter((node) => node.id !== launchNodeId)),
    [sessions, nodes, launchNodeId],
  );
  const autoLaunchNodeRef = useRef<string | null>(null);
  const autoLaunchTriedRef = useRef(false);
  useEffect(() => {
    if (!emptyStateActive) {
      autoLaunchTriedRef.current = false;
      return;
    }
    if (launchNodeId || autoLaunchTriedRef.current) return;
    autoLaunchTriedRef.current = true;
    const nodeId = onLaunchLeader();
    if (typeof nodeId === "string") {
      autoLaunchNodeRef.current = nodeId;
      setLaunchNodeId(nodeId);
    }
  }, [emptyStateActive, launchNodeId, onLaunchLeader]);

  useEffect(() => {
    if (emptyStateActive) return;
    const autoNodeId = autoLaunchNodeRef.current;
    if (!autoNodeId || autoNodeId !== launchNodeId) return;
    const node = nodes.find((candidate) => candidate.id === autoNodeId);
    if (node && !(node.data as LeaderData).sessionKey) {
      onCancelLaunchLeader(autoNodeId);
      setLaunchNodeId(null);
    }
    autoLaunchNodeRef.current = null;
  }, [emptyStateActive, launchNodeId, nodes, onCancelLaunchLeader]);

  // Unmount: drop an auto-created draft that never launched (latest state via ref).
  const unmountCleanupRef = useRef<() => void>(() => {});
  useEffect(() => {
    unmountCleanupRef.current = () => {
      const autoNodeId = autoLaunchNodeRef.current;
      if (!autoNodeId) return;
      const node = nodes.find((candidate) => candidate.id === autoNodeId);
      if (node && !(node.data as LeaderData).sessionKey) onCancelLaunchLeader(autoNodeId);
    };
  });
  useEffect(() => () => unmountCleanupRef.current(), []);

  // The concrete sessions currently checked for a bulk action, in list order.
  const checkedSessions = useMemo(
    () => activitySessions.filter((session) => checkedKeys.has(session.sessionKey)),
    [activitySessions, checkedKeys],
  );
  const bulkCounts = useMemo(
    () => ({
      reviewable: checkedSessions.filter((s) => canAcknowledge(s)).length,
      dismissed: checkedSessions.filter((s) => isDismissed(s)).length,
      open: checkedSessions.filter((s) => !isDismissed(s)).length,
    }),
    [checkedSessions],
  );

  const clearSelection = () => setCheckedKeys(new Set());
  const selectAllVisible = () =>
    setCheckedKeys(new Set(activitySessions.map((session) => session.sessionKey)));
  const applyBulk = (action: LifecycleAction) => {
    for (const session of checkedSessions) {
      if (action === "acknowledge" && !canAcknowledge(session)) continue;
      if (action === "dismiss" && isDismissed(session)) continue;
      if (action === "reopen" && !isDismissed(session)) continue;
      sendLifecycle(action, session);
    }
    clearSelection();
  };

  // The launch-only renderer owns the existing, well-tested session creation
  // path. Once that new session reaches Activity, replace the form with its
  // inspector instead of sending the user over to the canvas.
  useEffect(() => {
    if (!launchNode) return;
    const sessionKey = (launchNode.data as LeaderData).sessionKey;
    if (!sessionKey || !activitySessions.some((session) => session.sessionKey === sessionKey)) return;
    setSelectedKey(sessionKey);
    setLaunchNodeId(null);
  }, [activitySessions, launchNode]);

  // If the selected session disappears (cleared/ended off the list), drop the
  // inspector rather than leaving a dangling selection.
  useEffect(() => {
    if (selectedKey && !activitySessions.some((s) => s.sessionKey === selectedKey)) {
      setSelectedKey(null);
    }
  }, [activitySessions, selectedKey]);

  // Drop checked keys whose sessions have left the current view (e.g. after a
  // bulk dismiss moves them out of Open) so the bulk bar count stays honest.
  useEffect(() => {
    setCheckedKeys((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(activitySessions.map((s) => s.sessionKey));
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (visible.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [activitySessions]);

  return (
    <div className="act-root">
      <div className="act-main">
        <header className="act-header">
          <div className="act-header-main">
            <h1 className="act-header-title">Activity</h1>
            <span className="act-header-count">{activitySessions.length}</span>
          </div>
          <button
            className="act-launch-btn"
            type="button"
            onClick={openLaunchExperience}
            aria-label={launchNode ? "Launch workspace open" : "Launch leader"}
            disabled={Boolean(launchNode)}
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
        <div className="act-summary" aria-label="Filter activity by status">
          {summaryItems.map((item) => {
            const selected = summaryFilter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`act-summary-item${item.attention ? " act-summary-item--attention" : ""}${
                  selected ? " act-summary-item--active" : ""
                }`}
                aria-pressed={selected}
                aria-label={`${item.label}: ${item.count}. ${selected ? "Clear filter" : "Filter activity"}`}
                onClick={() => setSummaryFilter(selected ? null : item.id)}
              >
                <strong>{item.count}</strong><span>{item.label}</span>
              </button>
            );
          })}
        </div>
        <div className="act-filters" aria-label="Activity visibility">
          {(["open", "all", "dismissed"] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={`act-filter${visibility === id ? " act-filter--active" : ""}`}
              onClick={() => {
                setVisibility(id);
                setSummaryFilter(null);
              }}
            >
              {id === "open" ? "Open" : id === "all" ? "All" : "Dismissed"}
            </button>
          ))}
        </div>

        {actionError && (
          <div className="act-action-error" role="alert">
            <span>{actionError}</span>
            <button
              className="act-icon-btn"
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {checkedSessions.length > 0 && (
          <div className="act-bulk" role="toolbar" aria-label="Bulk actions">
            <span className="act-bulk-count">{checkedSessions.length} selected</span>
            <div className="act-bulk-actions">
              {bulkCounts.reviewable > 0 && (
                <button
                  className="act-btn act-btn--primary"
                  type="button"
                  onClick={() => applyBulk("acknowledge")}
                >
                  Mark {bulkCounts.reviewable} reviewed
                </button>
              )}
              {bulkCounts.open > 0 && (
                <button className="act-btn" type="button" onClick={() => applyBulk("dismiss")}>
                  Dismiss {bulkCounts.open}
                </button>
              )}
              {bulkCounts.dismissed > 0 && (
                <button className="act-btn" type="button" onClick={() => applyBulk("reopen")}>
                  Restore {bulkCounts.dismissed}
                </button>
              )}
              <button
                className="act-btn act-btn--ghost"
                type="button"
                onClick={selectAllVisible}
                disabled={checkedSessions.length === activitySessions.length}
              >
                Select all
              </button>
              <button className="act-btn act-btn--ghost" type="button" onClick={clearSelection}>
                Clear
              </button>
            </div>
          </div>
        )}

        {visibleSessions.length === 0 ? (
          <ActivityEmptyState
            title="No sessions yet"
            subtitle="Launch a leader and follow its work here."
            recent={recentWork}
            onOpenInCanvas={onOpenInCanvas}
            onAttachToCanvas={onAttachToCanvas}
            launchNode={launchNode}
            onLaunch={openLaunchExperience}
            onUpdateNodeData={onUpdateNodeData}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            projectPath={projectPath}
          />
        ) : activitySessions.length === 0 ? (
          <ActivityEmptyState
            title={visibilitySessions.length === 0
              ? visibility === "dismissed" ? "No dismissed sessions" : "No sessions in this view"
              : "No sessions match this activity filter"}
            onClearFilter={summaryFilter ? () => setSummaryFilter(null) : undefined}
            recent={recentWork}
            onOpenInCanvas={onOpenInCanvas}
            onAttachToCanvas={onAttachToCanvas}
            launchNode={launchNode}
            onLaunch={openLaunchExperience}
            onUpdateNodeData={onUpdateNodeData}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            projectPath={projectPath}
          />
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
                      checked={checkedKeys.has(session.sessionKey)}
                      onSelect={() => setSelectedKey(session.sessionKey)}
                      onToggleSelect={() => toggleChecked(session.sessionKey)}
                      onAction={sendLifecycle}
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
                      checked={checkedKeys.has(session.sessionKey)}
                      onCanvas={leaderIndex.has(session.sessionKey)}
                      hasChanges={session.reviewableChanges === true}
                      onSelect={() => setSelectedKey(session.sessionKey)}
                      onToggleSelect={() => toggleChecked(session.sessionKey)}
                      onAction={sendLifecycle}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      {!selectedSession && !launchNode && activitySessions.length > 0 && (
        <ActivitySessionHome
          sessions={activitySessions}
          onOpenSession={setSelectedKey}
          onLaunch={openLaunchExperience}
        />
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
          onAcknowledge={() => sendLifecycle("acknowledge", selectedSession)}
          onDismiss={() => sendLifecycle("dismiss", selectedSession)}
          onReopen={() => sendLifecycle("reopen", selectedSession)}
          {...(onPromptWorkItem ? { onPromptWorkItem } : {})}
          {...(selectedSession.workItemId && promptFailures[selectedSession.workItemId]
            ? { promptFailure: promptFailures[selectedSession.workItemId] }
            : {})}
          {...(selectedSession.workItemId && onClearPromptFailure
            ? { onClearPromptFailure: () => onClearPromptFailure(selectedSession.workItemId!) }
            : {})}
          runs={selectedSession.workItemId ? workItemRuns[selectedSession.workItemId] ?? [] : []}
          runNextCursor={selectedSession.workItemId ? runNextCursor[selectedSession.workItemId] ?? null : null}
          {...(selectedSession.workItemId && onLoadRuns
            ? { onLoadRuns: (cursor?: string) => onLoadRuns(selectedSession.workItemId!, cursor) }
            : {})}
        />
      )}

      {launchNode && !emptyStateActive && (
        <section className="act-launch-panel" aria-label="New leader">
          <header className="act-launch-head">
            <div>
              <span className="act-launch-eyebrow">New leader</span>
              <h2>What should it do?</h2>
              <p>The new leader will open here as soon as it starts.</p>
            </div>
            <button
              className="act-launch-close"
              type="button"
              onClick={closeLaunchExperience}
              aria-label={(launchNode.data as LeaderData).sessionKey ? "Close launch" : "Cancel new leader"}
            >
              <span aria-hidden>×</span>
            </button>
          </header>
          <div className="act-launch-inputs">
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
        </section>
      )}
    </div>
  );
}
