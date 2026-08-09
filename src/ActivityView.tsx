import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import {
  groupSessionsForTriage,
  isVisibleInActivity,
  isSessionTitleEcho,
  compareActivityPriority,
  type ActivityVisibility,
  needsAttention,
  attentionKind,
  attentionReason,
  attentionAction,
  activeMinionSummary,
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
import { ActivityTranscript } from "./WorkItemTranscript.tsx";
import {
  Activity as ActivityIcon,
  Check,
  ChevronRight,
  FileText,
  GitCompare,
  LayoutDashboard,
  ListX,
  Maximize2,
  MessageSquareText,
  Monitor,
  Paperclip,
  Pause,
  RotateCcw,
  Square,
  UsersRound,
  X,
} from "lucide-react";
import {
  SessionChangesPanel,
  leaderHasReviewableChanges,
} from "./ChangesView.tsx";
import type { ActiveMinion, SocketSubscribe, SyncTaskRecord } from "./use-socket.ts";
import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";
import { DashboardSurface } from "./nodes/render/DashboardSurface.tsx";
import { LeaderNodeRenderer } from "./nodes/LeaderNode.tsx";
import { ActivityEmptyState } from "./ActivityEmptyState.tsx";
import { ActivityOnboarding } from "./ActivityOnboarding.tsx";
import { ActivitySessionHome } from "./ActivitySessionHome.tsx";
import { selectRecentAgentWork } from "./activity-recent-work.ts";
import { randomUuid } from "./random-id.ts";
import { activityEntryId, type PromptFailure } from "./use-work-items.ts";
import {
  emptySessionStreamState,
  preserveOptimisticUserMessages,
} from "./session-stream.ts";
import { useSessionStream } from "./use-session-stream.ts";
import { useWorkItemHistory } from "./use-work-item-history.ts";
import { SessionTranscript } from "./components/SessionTranscript.tsx";
import { previousPrimaryRuns } from "./work-item-run-history.ts";
import type { DisplayMessage } from "./sdk-messages.ts";
import "./activity.css";

/**
 * Desktop Activity view — the default landing surface, mirroring the mobile
 * Activity screen on a wider canvas.
 *
 * Left: the live session list, grouped Active → Idle → Stopped (the same
 * `groupSessionsByActivity` selector mobile uses). Right: a structured
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
  /** Prepare a fresh Leader draft with the same defaults as Canvas. */
  onLaunchLeader: () => CanvasNode | string | void;
  /** Add an Activity draft to Canvas once its session has been initiated. */
  onCommitLaunchLeader: (node: CanvasNode) => void;
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
  /** Remove every canvas node attached to this session. */
  onDetachFromCanvas?: (
    session: Pick<MobileSessionInfo, "sessionKey" | "workItemId">,
  ) => void;
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
type InspectorSideTab = "dashboard" | "minions" | "details";

const ACTIVITY_OPTIMISTIC_USER_PREFIX = "activity-optimistic-user-";

function isAgentResponse(message: DisplayMessage): boolean {
  return message.role === "assistant" || message.role === "thinking"
    || message.role === "tool" || message.role === "result";
}

/** Replace an Activity-local user bubble once its durable server echo arrives. */
function collapseActivityOptimisticEchoes(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const matchedOptimistic = new Set<number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== "user"
      || message.id.startsWith(ACTIVITY_OPTIMISTIC_USER_PREFIX)) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = messages[j];
      if (!candidate || isAgentResponse(candidate)) break;
      if (candidate.role === "user"
        && candidate.id.startsWith(ACTIVITY_OPTIMISTIC_USER_PREFIX)
        && candidate.content === message.content
        && !matchedOptimistic.has(j)) {
        matchedOptimistic.add(j);
        break;
      }
    }
  }
  return matchedOptimistic.size === 0
    ? [...messages]
    : messages.filter((_, index) => !matchedOptimistic.has(index));
}

/**
 * The command names whose server responses the Activity view surfaces inline.
 * Rejected lifecycle mutations must land in a visible banner so the
 * Check/X/bulk controls always provide feedback.
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

function isRetainedInactive(session: MobileSessionInfo): boolean {
  return session.status === "inactive"
    && session.reviewLifecycle?.reviewState === "interrupted_to_review"
    && session.reviewLifecycle.acknowledgedAt == null
    && session.reviewLifecycle.dismissedAt == null;
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
  const retainedInactive = isRetainedInactive(session);
  const act = (action: LifecycleAction) => (event: MouseEvent) => {
    event.stopPropagation();
    onAction(action, session);
  };
  return (
    <span
      className={className ?? "act-life-actions"}
      role="group"
      aria-label={`${sessionDisplayTitle(session)} actions`}
    >
      {canAcknowledge(session) && (
        <button
          className="act-icon-action act-icon-action--review"
          type="button"
          onClick={act("acknowledge")}
          aria-label={retainedInactive ? "Review" : "Mark reviewed"}
          title={retainedInactive ? "Review and keep in Activity" : "Mark reviewed"}
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
          aria-label={retainedInactive ? "Review and remove from Activity" : "Dismiss"}
          title={retainedInactive
            ? "Review, remove from Activity, and detach from Canvas"
            : "Dismiss"}
        >
          {retainedInactive
            ? <ListX size={14} strokeWidth={2.25} aria-hidden />
            : <X size={14} strokeWidth={2.25} aria-hidden />}
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
  const retainedInactive = isRetainedInactive(session);
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
          {kind === "inactive"
            ? <Pause size={15} />
            : kind === "error"
              ? "!"
              : kind === "waiting"
                ? "?"
                : <GitCompare size={15} />}
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
        {!retainedInactive && (
          <button
            className="act-mini-btn act-mini-btn--primary act-mini-btn--open"
            type="button"
            onClick={onSelect}
          >
            {attentionAction(session)}
          </button>
        )}
        <LifecycleActions session={session} onAction={onAction} />
      </span>
    </div>
  );
}

function SessionCard({
  session,
  selected,
  checked,
  hasChanges,
  onSelect,
  onToggleSelect,
  onAction,
}: {
  session: ActivitySession;
  selected: boolean;
  checked: boolean;
  hasChanges: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onAction: (action: LifecycleAction, session: ActivitySession) => void;
}) {
  const tone = session.status === "running" || session.status === "creating"
    ? "running"
    : session.status === "completed"
      ? "completed"
    : session.status === "idle" || session.status === "inactive"
      ? "idle"
      : "other";
  const stateLabel = session.status === "creating"
    ? "Starting"
    : session.status === "inactive"
      ? "Paused"
    : tone === "running"
      ? "Working now"
      : tone === "idle"
        ? "Ready for input"
        : readableStatus(session.status);
  const reportedActivity = session.lastActivity?.trim();
  const genericActivity = reportedActivity && new Set([
    "active",
    "idle",
    "inactive",
    "running",
    "working",
  ]).has(reportedActivity.toLocaleLowerCase());
  const activitySummary = !genericActivity && reportedActivity
    && !isSessionTitleEcho(session, reportedActivity)
    ? reportedActivity
    : null;
  const activityTime = session.lastActivityAt
    ? `${tone === "idle" ? "Last active" : "Updated"} ${timeAgo(session.lastActivityAt)}`
    : tone === "running"
      ? "Live now"
      : tone === "idle"
        ? "No recent activity"
        : "No update time";
  const activeMinionCount = activeMinionSummary(session).running;
  const classes = [
    "act-card",
    `act-card--${tone}`,
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
          <span className="act-card-state">
            <span className="act-card-state-dot" aria-hidden />
            <span>{stateLabel}</span>
          </span>
        </span>
        <span className="act-card-title">{sessionDisplayTitle(session)}</span>
        {activitySummary && <span className="act-card-activity">{activitySummary}</span>}
        <span className="act-card-foot">
          <span className="act-card-time">{activityTime}</span>
          <span className="act-card-foot-tags">
            {activeMinionCount > 0 && (
              <span className="act-card-minions">
                <UsersRound size={10} strokeWidth={2.25} aria-hidden />
                {activeMinionCount} {activeMinionCount === 1 ? "minion" : "minions"} working
              </span>
            )}
            {hasChanges && (
              <span className="act-card-changes">
                <GitCompare size={9} strokeWidth={2.5} aria-hidden /> changes
              </span>
            )}
          </span>
        </span>
      </button>
      <LifecycleActions session={session} onAction={onAction} className="act-card-actions" />
    </div>
  );
}

function initialInspectorSideTab(
  session: MobileSessionInfo,
  minionCount: number,
): InspectorSideTab {
  if (session.renderState && session.renderState.components.length > 0) return "dashboard";
  if (session.role === "leader" && minionCount > 0) return "minions";
  return "details";
}

function minionRosterFromPlan(tasks: ReadonlyArray<SyncTaskRecord>): ActiveMinion[] {
  return tasks
    .filter((task) => task.executor === "minion")
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      sessionKey: task.minionSessionKey,
    }));
}

/**
 * Keep Activity's roster identical to the minion list rendered by the matching
 * canvas leader. Session snapshots remain the fallback for leaders that are
 * not attached to this canvas.
 */
export function selectActivityMinions(
  session: MobileSessionInfo,
  canvasTaskPlan?: ReadonlyArray<SyncTaskRecord>,
): ActiveMinion[] {
  if (session.role !== "leader") return [];
  if (canvasTaskPlan !== undefined) return minionRosterFromPlan(canvasTaskPlan);
  if (session.taskPlan !== undefined) return minionRosterFromPlan(session.taskPlan);
  return session.activeMinions ?? [];
}

function minionStatusTone(
  status: string,
): "running" | "blocked" | "planned" | "completed" | "idle" {
  if (status === "running" || status === "starting") return "running";
  if (status === "blocked") return "blocked";
  if (status === "planned") return "planned";
  if (status === "completed") return "completed";
  return "idle";
}

function readableStatus(status: string): string {
  return status.replace(/[-_]/g, " ");
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
  const minions = selectActivityMinions(session, leader?.data.taskPlan);
  const [reply, setReply] = useState("");
  const [conversation, setConversation] = useState(
    () => emptySessionStreamState(session.sessionKey),
  );
  const [awaitingResponse, setAwaitingResponse] = useState<{
    baselineResponseIds: Set<string>;
  } | null>(null);
  const [activeSideTab, setActiveSideTab] = useState<InspectorSideTab>(
    () => initialInspectorSideTab(session, minions.length),
  );
  const manuallySelectedSideTab = useRef(false);
  const [previewRunKey, setPreviewRunKey] = useState<string | null>(null);
  useEffect(() => {
    manuallySelectedSideTab.current = false;
    setActiveSideTab(initialInspectorSideTab(session, minions.length));
    setPreviewRunKey(null);
  }, [session.sessionKey]);
  useEffect(() => {
    setConversation(emptySessionStreamState(session.sessionKey));
    setAwaitingResponse(null);
    if (!session.sessionKey.startsWith("work-item:")) {
      socketSend?.({ type: "sync_session", sessionKey: session.sessionKey });
    }
  }, [session.sessionKey, socketSend]);
  useSessionStream({
    socketSubscribe,
    state: conversation,
    onChange: (next) => setConversation((current) => ({
      ...next,
      messages: preserveOptimisticUserMessages(current.messages, next.messages),
    })),
    prefix: "activity",
  });
  useEffect(() => {
    if (promptFailure) {
      setReply(promptFailure.prompt);
      setAwaitingResponse(null);
    }
  }, [promptFailure]);

  const hasDashboard = Boolean(
    session.renderState && session.renderState.components.length > 0,
  );
  useEffect(() => {
    if (hasDashboard && !manuallySelectedSideTab.current) {
      setActiveSideTab("dashboard");
    }
  }, [hasDashboard, session.sessionKey]);
  const conversationMatches = conversation.sessionKey === session.sessionKey;
  const rawTranscriptMessages = conversationMatches && conversation.messages.length > 0
    ? preserveOptimisticUserMessages(leader?.data.messages ?? [], conversation.messages)
    : leader?.data.messages ?? [];
  const transcriptMessages = collapseActivityOptimisticEchoes(rawTranscriptMessages);
  const streamingText = conversationMatches && conversation.streamingText
    ? conversation.streamingText
    : leader?.data.streamingText ?? "";
  useEffect(() => {
    if (!awaitingResponse) return;
    const hasNewResponse = transcriptMessages.some((message) =>
      isAgentResponse(message) && !awaitingResponse.baselineResponseIds.has(message.id));
    const responseFailed = conversationMatches && conversation.status === "error";
    if (streamingText || hasNewResponse || responseFailed) {
      setAwaitingResponse(null);
    }
  }, [awaitingResponse, conversation.status, conversationMatches, streamingText, transcriptMessages]);

  const markPromptSubmitted = (prompt: string) => {
    const optimisticMessage: DisplayMessage = {
      id: `activity-optimistic-user-${randomUuid()}`,
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    };
    setAwaitingResponse({
      baselineResponseIds: new Set(
        transcriptMessages.filter(isAgentResponse).map((message) => message.id),
      ),
    });
    setConversation((current) => ({
      ...current,
      sessionKey: session.sessionKey,
      status: "running",
      messages: [...transcriptMessages, optimisticMessage],
    }));
    setReply("");
  };

  const submitReply = () => {
    const prompt = reply.trim();
    // Only canonical entries carry the work item's revision counter; a session
    // that merely references a work item must use the session envelope or the
    // server rejects the mutation as a stale work-item lifecycle.
    const canonical = Boolean(session.workItemId && session.canonicalWorkItem);
    const blockedCanonicalWait = Boolean(canonical && session.status === "waiting"
      && session.reviewLifecycle?.reviewState !== "decision_needed");
    if (!prompt || !socketSend || blockedCanonicalWait) return;
    if (canonical && session.workItemId && onPromptWorkItem) {
      if (onPromptWorkItem(session.workItemId, prompt) !== false) markPromptSubmitted(prompt);
      return;
    }
    socketSend(canonical ? {
      type: "continue_work_item",
      requestId: randomUuid(), workItemId: session.workItemId, prompt, displayPrompt: prompt,
      expectedLifecycleRevision: session.reviewLifecycle?.lifecycleRevision ?? 0,
      expectedCurrentRunKey: session.sessionKey.startsWith("work-item:") ? null : session.sessionKey,
    } : { type: "send_message", sessionKey: session.sessionKey, prompt, displayPrompt: prompt });
    markPromptSubmitted(prompt);
  };
  const workItemHistory = useWorkItemHistory({
    workItemId: session.workItemId,
    runs,
    runNextCursor,
    ...(onLoadRuns ? { onLoadRuns } : {}),
    ...(socketSend ? { socketSend } : {}), ...(socketSubscribe ? { socketSubscribe } : {}),
  });
  const historicalRuns = useMemo(
    () => previousPrimaryRuns(workItemHistory.orderedRuns, session.sessionKey),
    [session.sessionKey, workItemHistory.orderedRuns],
  );
  const previewRun = historicalRuns.find((run) => run.runKey === previewRunKey) ?? null;
  const previewStream = previewRun ? workItemHistory.streams[previewRun.runKey] : undefined;
  useEffect(() => {
    if (previewRunKey && !historicalRuns.some((run) => run.runKey === previewRunKey)) {
      setPreviewRunKey(null);
    }
  }, [historicalRuns, previewRunKey]);
  const isSyntheticWorkItem = session.sessionKey.startsWith("work-item:");
  const sideTabs: Array<{
    id: InspectorSideTab;
    label: string;
    icon: typeof ActivityIcon;
  }> = [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: LayoutDashboard,
    },
    {
      id: "minions",
      label: "Minions",
      icon: UsersRound,
    },
    {
      id: "details",
      label: "Session details",
      icon: ActivityIcon,
    },
  ];
  const chooseSideTab = (tab: InspectorSideTab) => {
    manuallySelectedSideTab.current = true;
    setActiveSideTab(tab);
  };
  const handleSideTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: InspectorSideTab,
  ) => {
    const currentIndex = sideTabs.findIndex((tab) => tab.id === currentTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % sideTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + sideTabs.length) % sideTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = sideTabs.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    const nextTab = sideTabs[nextIndex]!.id;
    chooseSideTab(nextTab);
    requestAnimationFrame(() => {
      document.getElementById(`act-context-tab-${nextTab}`)?.focus();
    });
  };

  return (
    <aside className="act-inspector" aria-label="Session details">
      <header className="act-inspector-topbar">
        <div className="act-inspector-identity">
          <span className="act-inspector-avatar" aria-hidden>
            <ActivityIcon size={16} strokeWidth={2.2} />
          </span>
          <div>
            <div className="act-inspector-meta">
              <span className="act-inspector-kicker">{sessionRoleLabel(session)} session</span>
              <StatusPill status={session.status} />
            </div>
            <h2>{sessionDisplayTitle(session)}</h2>
          </div>
        </div>
        <div className="act-inspector-topactions">
          {leader ? (
            <>
              <button
                className="act-toolbar-btn"
                type="button"
                onClick={() => onOpenInCanvas(leader.nodeId)}
                aria-label="Open in Canvas"
              >
                <Monitor size={14} aria-hidden />
                <span>Open in Canvas</span>
              </button>
              <button
                className="act-toolbar-btn act-toolbar-btn--primary"
                type="button"
                onClick={() => onExpandFullscreen(leader.nodeId)}
                aria-label="Expand fullscreen"
              >
                <Maximize2 size={14} aria-hidden />
                <span>Expand fullscreen</span>
              </button>
            </>
          ) : (
            <button
              className="act-toolbar-btn"
              type="button"
              onClick={() => onAttachToCanvas(session.sessionKey)}
              aria-label="Add to canvas"
            >
              <Paperclip size={14} aria-hidden />
              <span>Add to canvas</span>
            </button>
          )}
          <button
            className="act-inspector-close"
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
          >
            <X size={17} aria-hidden />
          </button>
        </div>
      </header>

      <div className="act-inspector-layout">
        <main className="act-conversation-pane" aria-label="Conversation">
          {session.reviewLifecycle && session.reviewLifecycle.reviewState !== "none" &&
            session.reviewLifecycle.acknowledgedAt == null && (
              <div className={`act-review-banner act-review-banner--${attentionKind(session)}`}>
                <span className="act-review-banner-icon" aria-hidden>
                  {attentionKind(session) === "inactive"
                    ? <Pause size={15} />
                    : attentionKind(session) === "error"
                      ? "!"
                      : attentionKind(session) === "waiting"
                        ? "?"
                        : <GitCompare size={15} />}
                </span>
                <span>
                  <strong>{attentionReason(session)}</strong>
                  <small>
                    {isRetainedInactive(session)
                      ? "Review keeps this work in Activity. Review & remove clears it from Activity and detaches it from Canvas."
                      : session.reviewLifecycle.reviewReason}
                  </small>
                </span>
              </div>
            )}
          <div className="act-conversation-scroll">
            <section className="act-conversation" aria-label="Conversation history">
              {transcriptMessages.length > 0 || streamingText || workItemHistory.orderedRuns.length > 0 ? (
                <ActivityTranscript unified={Boolean(session.workItemId)} history={workItemHistory}
                  currentRunKey={session.sessionKey} currentMessages={transcriptMessages}
                  currentStreamingText={streamingText} thinking={Boolean(awaitingResponse)} />
              ) : (
                <div className="act-inspector-fallback">
                  <span className="act-fallback-icon" aria-hidden>
                    <MessageSquareText size={18} />
                  </span>
                  <h4>{isSyntheticWorkItem ? "No session run yet" : "No conversation yet"}</h4>
                  <p>
                    {isSyntheticWorkItem
                      ? "Send a message below to start this work item’s first session."
                      : "Messages from this session will appear here as soon as they are available."}
                  </p>
                  {session.lastActivity && (
                    <p className="act-inspector-lastactivity">{session.lastActivity}</p>
                  )}
                </div>
              )}
            </section>
          </div>
          {promptFailure && (
            <div className="act-action-error" role="alert">
              <span>{promptFailure.error}</span>
              <button className="act-icon-btn" type="button" onClick={onClearPromptFailure}
                aria-label="Dismiss prompt error">×</button>
            </div>
          )}
          <div className="act-composer">
            <div className="act-composer-inner">
              <textarea
                rows={3}
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
          </div>
        </main>

        <section className="act-context-panel" aria-label="Leader context">
          <div className="act-context-tabs" role="tablist" aria-label="Leader context views">
            {sideTabs.map((tab) => {
              const Icon = tab.icon;
              const selected = activeSideTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`act-context-tab-${tab.id}`}
                  className="act-context-tab"
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="act-context-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => chooseSideTab(tab.id)}
                  onKeyDown={(event) => handleSideTabKeyDown(event, tab.id)}
                >
                  <Icon size={14} aria-hidden />
                  <span>{tab.label}</span>
                  {tab.id === "minions" && minions.length > 0 && (
                    <small>{minions.length}</small>
                  )}
                </button>
              );
            })}
          </div>

          <div
            id="act-context-tabpanel"
            className="act-context-scroll"
            role="tabpanel"
            aria-labelledby={`act-context-tab-${activeSideTab}`}
          >
            {activeSideTab === "dashboard" && (
              <section className="act-side-stack" aria-label="Leader dashboard">
                <header className="act-side-heading">
                  <span>Live dashboard</span>
                  <h3>Progress and decisions</h3>
                  <p>Structured updates published by this leader.</p>
                </header>
                {hasDashboard && session.renderState ? (
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
                ) : (
                  <div className="act-side-empty">
                    <LayoutDashboard size={19} aria-hidden />
                    <strong>No dashboard published</strong>
                    <p>Structured progress updates will appear here without hiding the conversation.</p>
                  </div>
                )}
              </section>
            )}

            {activeSideTab === "minions" && (
              <section className="act-side-stack" aria-label="Minion roster">
                <header className="act-side-heading">
                  <span>Delegated work</span>
                  <h3>Minions</h3>
                  <p>Follow the supporting agents this leader is coordinating.</p>
                </header>
                {minions.length > 0 ? (
                  <div className="act-minion-list">
                    {minions.map((minion) => {
                      const tone = minionStatusTone(minion.status);
                      return (
                        <article
                          className="act-minion-row"
                          data-tone={tone}
                          key={minion.sessionKey ?? minion.taskId}
                        >
                          <span className="act-minion-dot" aria-hidden />
                          <div>
                            <strong>{minion.title || minion.taskId}</strong>
                            <small>{minion.taskId}</small>
                          </div>
                          <span className="act-minion-status">{readableStatus(minion.status)}</span>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="act-side-empty">
                    <UsersRound size={19} aria-hidden />
                    <strong>No minions yet</strong>
                    <p>Delegated tasks will appear here as soon as this leader assigns them.</p>
                  </div>
                )}
              </section>
            )}

            {activeSideTab === "details" && (
              <section className="act-side-stack" aria-label="Session details panel">
                <header className="act-side-heading">
                  <span>Session details</span>
                  <h3>Context and output</h3>
                  <p>Execution metadata, recent activity, and reviewable work.</p>
                </header>
                <article className="act-content-card">
                  <dl className="act-detail-list">
                    <div><dt>Status</dt><dd><StatusPill status={session.status} /></dd></div>
                    <div><dt>Role</dt><dd>{sessionRoleLabel(session)}</dd></div>
                    <div><dt>Model</dt><dd>{session.model ?? "Not reported"}</dd></div>
                    <div><dt>Harness</dt><dd>{session.harness ?? "Not reported"}</dd></div>
                    <div><dt>Turns</dt><dd>{session.turns ?? 0}</dd></div>
                    <div><dt>Total cost</dt><dd>{formatCost(session.totalCost)}</dd></div>
                  </dl>
                </article>
                <article className="act-content-card">
                  <header className="act-content-card__head">
                    <div>
                      <h4>Latest activity</h4>
                      <p>{session.lastActivityAt
                        ? `Updated ${timeAgo(session.lastActivityAt)}`
                        : "No timestamp was reported for this session."}</p>
                    </div>
                  </header>
                  <div className="act-latest-activity">
                    {session.lastActivity || "This leader has not published an activity summary yet."}
                  </div>
                </article>
                {showChanges && leader && (
                  <article className="act-content-card">
                    <header className="act-content-card__head">
                      <GitCompare size={16} aria-hidden />
                      <div>
                        <h4>Changes</h4>
                        <p>Review the leader’s working tree and integration options.</p>
                      </div>
                    </header>
                    <div className="act-content-card__body">
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
                  </article>
                )}
                {session.reviewLifecycle?.finalReport && (
                  <article className="act-content-card act-content-card--report">
                    <header className="act-content-card__head">
                      <FileText size={16} aria-hidden />
                      <div>
                        <h4>Final report</h4>
                        <p>The leader’s completed handoff and verification summary.</p>
                      </div>
                    </header>
                    <div className="act-final-report">{session.reviewLifecycle.finalReport}</div>
                  </article>
                )}
                {session.workItemId && (
                  <details className="act-content-card act-run-history">
                    <summary className="act-content-card__head">
                      <div>
                        <h4>Run history</h4>
                        <p>Review and preview every previous iteration for this work item.</p>
                      </div>
                      <ChevronRight size={15} aria-hidden />
                    </summary>
                    <div className="act-content-card__body">
                      {historicalRuns.length === 0 ? (
                        <p className="act-empty-copy">
                          {workItemHistory.loading ? "Loading previous iterations…" : "No previous iterations."}
                        </p>
                      ) : (
                        <ol aria-label="Run history">
                          {historicalRuns.map((run) => {
                            const selected = run.runKey === previewRunKey;
                            return (
                              <li key={run.runKey}>
                                <button
                                  className="act-run-history-item"
                                  type="button"
                                  aria-pressed={selected}
                                  onClick={() => setPreviewRunKey(selected ? null : run.runKey)}
                                >
                                  <strong>Iteration {run.runNumber}</strong>
                                  <span>{run.outcome}</span>
                                  <small>{run.endedAt
                                    ? new Date(run.endedAt).toLocaleString()
                                    : "Active now"}</small>
                                  <em>{selected ? "Hide preview" : "Preview"}</em>
                                </button>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                      {onLoadRuns && workItemHistory.loading && historicalRuns.length > 0 ? (
                        <p className="act-run-history-loading" role="status">
                          Loading earlier iterations…
                        </p>
                      ) : null}
                      {previewRun ? (
                        <section
                          className="act-run-preview"
                          aria-label={`Preview of iteration ${previewRun.runNumber}`}
                        >
                          <header>
                            <div>
                              <strong>Iteration {previewRun.runNumber}</strong>
                              <span>Read-only preview</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setPreviewRunKey(null)}
                              aria-label="Close iteration preview"
                            >
                              <X size={13} aria-hidden />
                            </button>
                          </header>
                          {previewStream ? (
                            <SessionTranscript messages={previewStream.messages} streamingText="" />
                          ) : (
                            <p className="act-empty-copy" role="status">Loading iteration preview…</p>
                          )}
                          {previewRun.finalReport ? (
                            <div className="act-run-preview-report">
                              <strong>Final report</strong>
                              <p>{previewRun.finalReport}</p>
                            </div>
                          ) : null}
                        </section>
                      ) : null}
                    </div>
                  </details>
                )}
              </section>
            )}
          </div>

          <div className="act-context-controls" aria-label="Session controls">
            {session.reviewLifecycle && session.reviewLifecycle.reviewState !== "none" &&
              session.reviewLifecycle.acknowledgedAt == null &&
              session.reviewLifecycle.dismissedAt == null && (
                <button
                  className="act-icon-action act-icon-action--review"
                  type="button"
                  onClick={onAcknowledge}
                  aria-label={isRetainedInactive(session) ? "Review" : "Mark reviewed"}
                  title={isRetainedInactive(session)
                    ? "Review and keep in Activity"
                    : "Mark reviewed"}
                >
                  <Check size={15} strokeWidth={2.5} aria-hidden />
                </button>
              )}
            {session.reviewLifecycle?.dismissedAt == null ? (
              <button
                className="act-icon-action act-icon-action--dismiss"
                type="button"
                onClick={onDismiss}
                aria-label={isRetainedInactive(session)
                  ? "Review and remove from Activity"
                  : "Dismiss"}
                title={isRetainedInactive(session)
                  ? "Review, remove from Activity, and detach from Canvas"
                  : "Dismiss"}
              >
                {isRetainedInactive(session)
                  ? <ListX size={15} strokeWidth={2.25} aria-hidden />
                  : <X size={15} strokeWidth={2.25} aria-hidden />}
              </button>
            ) : (
              <button
                className="act-icon-action"
                type="button"
                onClick={onReopen}
                aria-label="Restore"
                title="Restore"
              >
                <RotateCcw size={14} strokeWidth={2.25} aria-hidden />
              </button>
            )}
            <button
              className="act-icon-action act-icon-action--danger"
              type="button"
              disabled={!isRunning}
              onClick={() => onStopSession(session.sessionKey)}
              aria-label="Stop"
              title="Stop"
            >
              <Square size={12} fill="currentColor" aria-hidden />
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}

export function ActivityView({
  sessions,
  nodes,
  onLaunchLeader,
  onCommitLaunchLeader,
  onCancelLaunchLeader,
  onOpenInCanvas,
  onExpandFullscreen,
  onStopSession,
  onAttachToCanvas,
  onDetachFromCanvas,
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
  const [launchDraft, setLaunchDraft] = useState<CanvasNode | null>(null);
  const launchCommittedRef = useRef(false);
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

  const toggleChecked = (entryId: string) =>
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });

  const sendLifecycle = (action: LifecycleAction, session: MobileSessionInfo) => {
    if (action === "dismiss") {
      onDetachFromCanvas?.({
        sessionKey: session.sessionKey,
        ...(session.workItemId !== undefined
          ? { workItemId: session.workItemId }
          : {}),
      });
    }
    socketSend?.(buildLifecycleCommand(action, session, randomUuid()));
  };

  // Top-level surface only — minions are managed by their leader (mirrors mobile).
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.role !== "minion"),
    [sessions],
  );
  const leaderIndex = useMemo(() => buildLeaderNodeIndex(nodes), [nodes]);
  const canvasLaunchNode = launchNodeId
    ? nodes.find((node) => node.id === launchNodeId && node.type === "leader")
    : undefined;
  const launchNode = canvasLaunchNode ?? (launchDraft?.id === launchNodeId ? launchDraft : undefined);

  function openLaunchExperience() {
    if (launchNodeId) return;
    const draft = onLaunchLeader();
    if (typeof draft === "string") {
      setSelectedKey(null);
      setLaunchNodeId(draft);
    } else if (draft) {
      launchCommittedRef.current = false;
      setSelectedKey(null);
      setLaunchDraft(draft);
      setLaunchNodeId(draft.id);
    }
  }

  function closeLaunchExperience() {
    if (!launchNode) return;
    if (canvasLaunchNode && !(launchNode.data as LeaderData).sessionKey) {
      onCancelLaunchLeader(launchNode.id);
    }
    setLaunchDraft(null);
    setLaunchNodeId(null);
  }

  function updateLaunchNodeData(nodeId: string, data: LeaderData) {
    const current = launchNode?.id === nodeId ? launchNode : undefined;
    if (!current) return;
    const next = { ...current, data };
    setLaunchDraft(next);

    if (!launchCommittedRef.current && !canvasLaunchNode && data.sessionKey) {
      launchCommittedRef.current = true;
      onCommitLaunchLeader(next);
      return;
    }
    if (canvasLaunchNode || launchCommittedRef.current) {
      onUpdateNodeData(nodeId, data);
    }
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
  const emptyStateTitle = visibilitySessions.length === 0
    ? visibility === "dismissed" ? "No dismissed sessions" : "No sessions in this view"
    : "No sessions match this activity filter";
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
    () => activitySessions.find((s) => activityEntryId(s) === selectedKey) ?? null,
    [activitySessions, selectedKey],
  );

  const selectBySessionKey = (sessionKey: string) => {
    const entry = activitySessions.find((session) => session.sessionKey === sessionKey)
      ?? sessions.find((session) => session.sessionKey === sessionKey);
    setSelectedKey(entry ? activityEntryId(entry) : `session:${sessionKey}`);
  };

  // ── Empty-state launchpad ────────────────────────────────────────────────
  // Both empty states embed the full launch composer inline plus a preview of
  // the most recent agents' work. The composer uses an Activity-local draft;
  // it is not committed to Canvas until the launch assigns a session key.
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
    const draft = onLaunchLeader();
    if (typeof draft === "string") {
      autoLaunchNodeRef.current = draft;
      setLaunchNodeId(draft);
    } else if (draft) {
      launchCommittedRef.current = false;
      autoLaunchNodeRef.current = draft.id;
      setLaunchDraft(draft);
      setLaunchNodeId(draft.id);
    }
  }, [emptyStateActive, launchNodeId, onLaunchLeader]);

  useEffect(() => {
    if (emptyStateActive) return;
    const autoNodeId = autoLaunchNodeRef.current;
    if (!autoNodeId || autoNodeId !== launchNodeId) return;
    const node = nodes.find((candidate) => candidate.id === autoNodeId)
      ?? (launchDraft?.id === autoNodeId ? launchDraft : undefined);
    if (node && !(node.data as LeaderData).sessionKey) {
      if (nodes.some((candidate) => candidate.id === autoNodeId)) {
        onCancelLaunchLeader(autoNodeId);
      }
      setLaunchDraft(null);
      setLaunchNodeId(null);
    }
    autoLaunchNodeRef.current = null;
  }, [emptyStateActive, launchDraft, launchNodeId, nodes, onCancelLaunchLeader]);

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
    () => activitySessions.filter((session) => checkedKeys.has(activityEntryId(session))),
    [activitySessions, checkedKeys],
  );
  const bulkCounts = useMemo(
    () => ({
      reviewable: checkedSessions.filter((s) => canAcknowledge(s) && !isRetainedInactive(s)).length,
      retainedReviewable: checkedSessions.filter(
        (s) => canAcknowledge(s) && isRetainedInactive(s),
      ).length,
      dismissible: checkedSessions.filter(
        (s) => !isDismissed(s) && !isRetainedInactive(s),
      ).length,
      removable: checkedSessions.filter((s) => isRetainedInactive(s)).length,
      dismissed: checkedSessions.filter((s) => isDismissed(s)).length,
    }),
    [checkedSessions],
  );

  const clearSelection = () => setCheckedKeys(new Set());
  const selectAllVisible = () =>
    setCheckedKeys(new Set(activitySessions.map(activityEntryId)));
  const applyBulk = (
    action: LifecycleAction,
    isEligible: (session: ActivitySession) => boolean,
  ) => {
    for (const session of checkedSessions) {
      if (!isEligible(session)) continue;
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
    const launched = activitySessions.find((session) => session.sessionKey === sessionKey);
    setSelectedKey(launched ? activityEntryId(launched) : `session:${sessionKey}`);
    setLaunchDraft(null);
    setLaunchNodeId(null);
  }, [activitySessions, launchNode]);

  // Durable selection survives a work item's active-run replacement.
  useEffect(() => {
    if (selectedKey && !activitySessions.some((s) => activityEntryId(s) === selectedKey)) {
      setSelectedKey(null);
    }
  }, [activitySessions, selectedKey]);

  // Drop checked keys whose sessions have left the current view (e.g. after a
  // bulk dismiss moves them out of Open) so the bulk bar count stays honest.
  useEffect(() => {
    setCheckedKeys((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(activitySessions.map(activityEntryId));
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
            <div className="act-bulk-head">
              <span className="act-bulk-count">{checkedSessions.length} selected</span>
              <div className="act-bulk-selection-actions">
                {checkedSessions.length < activitySessions.length && (
                  <button
                    className="act-bulk-select-all"
                    type="button"
                    onClick={selectAllVisible}
                  >
                    Select all {activitySessions.length}
                  </button>
                )}
                <button
                  className="act-bulk-clear"
                  type="button"
                  onClick={clearSelection}
                  aria-label="Clear selection"
                  title="Clear selection"
                >
                  <X size={14} strokeWidth={2.25} aria-hidden />
                </button>
              </div>
            </div>
            <div className="act-bulk-actions" role="group" aria-label="Selected activity actions">
              {bulkCounts.reviewable > 0 && (
                <button
                  className="act-bulk-action act-bulk-action--review"
                  type="button"
                  onClick={() => applyBulk(
                    "acknowledge",
                    (session) => canAcknowledge(session) && !isRetainedInactive(session),
                  )}
                  aria-label={`Mark ${bulkCounts.reviewable} reviewed`}
                >
                  <Check size={14} strokeWidth={2.5} aria-hidden />
                  <span>Mark reviewed</span>
                </button>
              )}
              {bulkCounts.retainedReviewable > 0 && (
                <button
                  className="act-bulk-action act-bulk-action--review"
                  type="button"
                  onClick={() => applyBulk(
                    "acknowledge",
                    (session) => canAcknowledge(session) && isRetainedInactive(session),
                  )}
                  aria-label={`Review ${bulkCounts.retainedReviewable}`}
                >
                  <Check size={14} strokeWidth={2.5} aria-hidden />
                  <span>Review and keep in Activity</span>
                </button>
              )}
              {bulkCounts.removable > 0 && (
                <button
                  className="act-bulk-action act-bulk-action--dismiss"
                  type="button"
                  onClick={() => applyBulk(
                    "dismiss",
                    (session) => isRetainedInactive(session),
                  )}
                  aria-label={`Review and remove ${bulkCounts.removable} from Activity`}
                >
                  <ListX size={14} strokeWidth={2.25} aria-hidden />
                  <span>Review and remove</span>
                </button>
              )}
              {bulkCounts.dismissible > 0 && (
                <button
                  className="act-bulk-action act-bulk-action--dismiss"
                  type="button"
                  onClick={() => applyBulk(
                    "dismiss",
                    (session) => !isDismissed(session) && !isRetainedInactive(session),
                  )}
                  aria-label={`Dismiss ${bulkCounts.dismissible}`}
                >
                  <X size={14} strokeWidth={2.25} aria-hidden />
                  <span>Dismiss</span>
                </button>
              )}
              {bulkCounts.dismissed > 0 && (
                <button
                  className="act-bulk-action"
                  type="button"
                  onClick={() => applyBulk("reopen", (session) => isDismissed(session))}
                  aria-label={`Restore ${bulkCounts.dismissed}`}
                >
                  <RotateCcw size={13} strokeWidth={2.25} aria-hidden />
                  <span>Restore</span>
                </button>
              )}
            </div>
          </div>
        )}

        {activitySessions.length === 0 ? (
          <div className="act-list-empty" aria-label="Empty session list">
            <strong>{visibleSessions.length === 0 ? "Session list is empty" : "Nothing in this list"}</strong>
            <span>
              {visibleSessions.length === 0
                ? "Your leader sessions will appear here."
                : "Use the workspace to adjust this view or start something new."}
            </span>
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
                      key={activityEntryId(session)}
                      session={session}
                      selected={activityEntryId(session) === selectedKey}
                      checked={checkedKeys.has(activityEntryId(session))}
                      onSelect={() => setSelectedKey(activityEntryId(session))}
                      onToggleSelect={() => toggleChecked(activityEntryId(session))}
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
                      key={activityEntryId(session)}
                      session={session}
                      selected={activityEntryId(session) === selectedKey}
                      checked={checkedKeys.has(activityEntryId(session))}
                      hasChanges={session.reviewableChanges === true}
                      onSelect={() => setSelectedKey(activityEntryId(session))}
                      onToggleSelect={() => toggleChecked(activityEntryId(session))}
                      onAction={sendLifecycle}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      {activitySessions.length === 0 && (
        <main
          className={`act-empty-workspace${visibleSessions.length === 0 ? " act-launch-panel" : ""}`}
          aria-label="Activity workspace"
        >
          {visibleSessions.length === 0 ? <ActivityOnboarding /> : null}
          <div className={visibleSessions.length === 0
            ? "act-launch-inputs"
            : "act-empty-workspace__content"}
          >
            <ActivityEmptyState
              title={visibleSessions.length === 0 ? undefined : emptyStateTitle}
              launchLayout={visibleSessions.length === 0}
              onClearFilter={summaryFilter ? () => setSummaryFilter(null) : undefined}
              recent={recentWork}
              onOpenInCanvas={onOpenInCanvas}
              onOpenSession={(sessionKey) => {
                setSummaryFilter(null);
                selectBySessionKey(sessionKey);
              }}
              launchNode={launchNode}
              onLaunch={openLaunchExperience}
              onUpdateNodeData={updateLaunchNodeData}
              socketSend={socketSend}
              socketSubscribe={socketSubscribe}
              projectPath={projectPath}
            />
          </div>
        </main>
      )}

      {!selectedSession && !launchNode && activitySessions.length > 0 && (
        <ActivitySessionHome
          sessions={activitySessions}
          onOpenSession={selectBySessionKey}
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
          {...(selectedSession.workItemId && selectedSession.workItemId in runNextCursor
            ? { runNextCursor: runNextCursor[selectedSession.workItemId] ?? null }
            : {})}
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
              onUpdateData={(data) => updateLaunchNodeData(launchNode.id, data as LeaderData)}
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
