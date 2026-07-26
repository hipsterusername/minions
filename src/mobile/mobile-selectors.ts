import type { SessionInfo } from "../use-socket.ts";

export type MobileSessionInfo = SessionInfo & {
  liveEditAwareness?: import("../../shared/live-edit-coordination.ts").LiveEditAwareness;
  lastActivity?: string | null;
  lastActivityAt?: number | null;
  pendingAttention?: boolean;
  reviewableChanges?: boolean;
  /**
   * True only for entries synthesized from a canonical work-item snapshot, where
   * `reviewLifecycle.lifecycleRevision` is the WORK ITEM's revision counter.
   * Sessions that merely reference a work item (`workItemId` set) but were not
   * merged from the canonical list carry the SESSION's own revision counter —
   * a different clock — so work-item mutations built from them would be
   * rejected as "stale work-item lifecycle". Route those through the
   * session-scoped commands instead, which resolve fresh work-item state
   * server-side.
   */
  canonicalWorkItem?: boolean;
};

/** Statuses where the agent is doing work right now. */
const ACTIVE_STATUSES = new Set(["running", "creating", "waiting"]);
/** Terminal statuses — the session has ended (or its socket dropped). */
const STOPPED_STATUSES = new Set(["stopped", "completed", "disconnected"]);

/**
 * The three activity buckets the Activity screen groups by, in display order.
 * `idle` is the catch-all middle bucket: it holds `idle`, `error` (still
 * reopenable and awaiting the user — kept visible via the attention highlight),
 * and any unrecognised status.
 */
export type ActivitySectionId = "active" | "idle" | "stopped";

export const ACTIVITY_SECTION_ORDER: readonly ActivitySectionId[] = [
  "active",
  "idle",
  "stopped",
] as const;

const ACTIVITY_SECTION_TITLES: Record<ActivitySectionId, string> = {
  active: "Active",
  idle: "Idle",
  stopped: "Stopped / Cleared",
};

export interface ActivitySection<T extends MobileSessionInfo> {
  id: ActivitySectionId;
  title: string;
  sessions: T[];
}

/**
 * A leader's active-minion roster, reduced to the counts the mobile surfaces
 * use to advertise live progress. `total` is the raw number of minions the
 * leader is currently tracking; the tone buckets classify each by status so
 * the UI can pulse the ones that are actually working right now.
 */
export interface MinionActivitySummary {
  running: number;
  blocked: number;
  planned: number;
  total: number;
}

/** Statuses where a tracked minion is actively executing work right now. */
const MINION_RUNNING_STATUSES = new Set(["running", "starting"]);

/**
 * Reduce a session's `activeMinions` into the counts the mobile Activity list
 * and leader session strip use to show live progress at a glance. Non-leader
 * sessions (and sessions with no roster) collapse to all-zero counts.
 */
export function activeMinionSummary(session: MobileSessionInfo): MinionActivitySummary {
  const minions = session.role === "leader" ? session.activeMinions ?? [] : [];
  const summary: MinionActivitySummary = { running: 0, blocked: 0, planned: 0, total: minions.length };
  for (const minion of minions) {
    if (MINION_RUNNING_STATUSES.has(minion.status)) summary.running += 1;
    else if (minion.status === "blocked") summary.blocked += 1;
    else if (minion.status === "planned") summary.planned += 1;
  }
  return summary;
}

/** Whether any tracked minion is actively executing (used to drive live pulses). */
export function hasLiveMinions(summary: MinionActivitySummary): boolean {
  return summary.running > 0;
}

export function needsAttention(session: MobileSessionInfo): boolean {
  const lifecycle = session.reviewLifecycle;
  if (lifecycle) {
    if (lifecycle.dismissedAt !== null || lifecycle.acknowledgedAt !== null) {
      return session.reviewableChanges === true;
    }
    if (lifecycle.reviewState !== "none") return true;
  }
  return (
    session.status === "error" ||
    session.status === "waiting" ||
    session.pendingAttention === true ||
    session.reviewableChanges === true
  );
}

/**
 * The three attention "flavours" that colour the Activity triage lane. `error`
 * covers crashes/interruptions, `waiting` covers decisions the agent is blocked
 * on, and `changes` covers a run whose diff is ready to review.
 */
export type AttentionKind = "error" | "waiting" | "changes";

/** Classify why a session needs the user, driving its triage icon/accent. */
export function attentionKind(session: MobileSessionInfo): AttentionKind {
  const reviewState = session.reviewLifecycle?.reviewState;
  if (reviewState === "error_to_review" || reviewState === "interrupted_to_review") return "error";
  if (reviewState === "decision_needed") return "waiting";
  if (session.status === "error") return "error";
  if (session.status === "waiting" || session.pendingAttention === true) return "waiting";
  return "changes";
}

/** Short human reason shown beside a triage row's title. */
export function attentionReason(session: MobileSessionInfo): string {
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

/** The verb for a triage row's primary action button. */
export function attentionAction(session: MobileSessionInfo): string {
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

export type ActivityVisibility = "open" | "all" | "dismissed";

export function isVisibleInActivity(
  session: MobileSessionInfo,
  visibility: ActivityVisibility,
): boolean {
  const dismissed = session.reviewLifecycle?.dismissedAt != null;
  if (visibility === "all") return true;
  return visibility === "dismissed" ? dismissed : !dismissed;
}

const REVIEW_PRIORITY: Record<string, number> = {
  decision_needed: 0,
  error_to_review: 1,
  interrupted_to_review: 2,
  completion_to_review: 3,
  none: 4,
};

export function compareActivityPriority<T extends MobileSessionInfo>(a: T, b: T): number {
  const aLifecycle = a.reviewLifecycle;
  const bLifecycle = b.reviewLifecycle;
  const aAcknowledged = aLifecycle?.acknowledgedAt != null;
  const bAcknowledged = bLifecycle?.acknowledgedAt != null;
  const aPriority = aAcknowledged ? 5 : REVIEW_PRIORITY[aLifecycle?.reviewState ?? "none"] ?? 4;
  const bPriority = bAcknowledged ? 5 : REVIEW_PRIORITY[bLifecycle?.reviewState ?? "none"] ?? 4;
  if (aPriority !== bPriority) return aPriority - bPriority;
  const aAt = aLifecycle?.terminalAt ?? a.lastActivityAt ?? 0;
  const bAt = bLifecycle?.terminalAt ?? b.lastActivityAt ?? 0;
  return bAt - aAt || sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b));
}

/**
 * Whether a session belongs to the project rooted at `projectPath`.
 *
 * A session is owned by a project when its working directory is the project
 * root itself, or lives underneath it. Worktree-isolated leaders run from
 * `<projectPath>/.minions/worktrees/<key>`, so the subpath check keeps them
 * grouped under their originating project without needing a server-side
 * project id on each session.
 */
export function sessionBelongsToProject(
  session: Pick<SessionInfo, "cwd">,
  projectPath: string,
): boolean {
  if (!projectPath) return false;
  const cwd = session.cwd;
  if (!cwd) return false;
  if (cwd === projectPath) return true;
  const prefix = projectPath.endsWith("/") ? projectPath : `${projectPath}/`;
  return cwd.startsWith(prefix);
}

/** Classify a session status into its activity section. */
export function activitySection(status: string): ActivitySectionId {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (STOPPED_STATUSES.has(status)) return "stopped";
  return "idle";
}

export function sessionDisplayTitle(session: SessionInfo): string {
  const taskName = session.taskName?.trim();
  if (taskName) return taskName;
  return session.sessionKey;
}

export function sessionRoleLabel(session: SessionInfo): string {
  switch (session.role) {
    case "leader":
      return "Leader";
    case "minion":
      return "Minion";
    case "card-composer":
      return "Card Composer";
    case "default":
    case undefined:
      return "Session";
    default:
      return "Session";
  }
}

/**
 * Order sessions within a single section: most recently active first, then
 * sessions needing attention, then alphabetically by title for stable output.
 */
export function compareWithinSection<T extends MobileSessionInfo>(a: T, b: T): number {
  const activityDelta = (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  if (activityDelta !== 0) return activityDelta;

  const attentionDelta = Number(needsAttention(b)) - Number(needsAttention(a));
  if (attentionDelta !== 0) return attentionDelta;

  return sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b));
}

/**
 * Group sessions into activity sections (Active → Idle → Stopped/Cleared) for
 * the mobile Activity screen. Sections keep their fixed order; empty ones are
 * omitted. Within each section, the most recently active conversation is first.
 */
export function groupSessionsByActivity<T extends MobileSessionInfo>(
  sessions: ReadonlyArray<T>,
): ActivitySection<T>[] {
  const buckets: Record<ActivitySectionId, T[]> = {
    active: [],
    idle: [],
    stopped: [],
  };

  for (const session of sessions) {
    buckets[activitySection(session.status)].push(session);
  }

  return ACTIVITY_SECTION_ORDER.flatMap((id) => {
    const bucket = buckets[id].sort(compareWithinSection);
    if (bucket.length === 0) return [];
    return [{ id, title: ACTIVITY_SECTION_TITLES[id], sessions: bucket }];
  });
}

export interface ActivityTriage<T extends MobileSessionInfo> {
  needsYou: T[];
  sections: ActivitySection<T>[];
}

/**
 * Split sessions into a pinned attention lane and the normal activity buckets.
 * Attention-worthy sessions are removed from their original bucket so the
 * Activity surface has one obvious place to resolve them.
 */
export function groupSessionsForTriage<T extends MobileSessionInfo>(
  sessions: ReadonlyArray<T>,
): ActivityTriage<T> {
  const needsYou: T[] = [];
  const rest: T[] = [];

  for (const session of sessions) {
    if (needsAttention(session)) needsYou.push(session);
    else rest.push(session);
  }

  return {
    needsYou: needsYou.sort(compareWithinSection),
    sections: groupSessionsByActivity(rest),
  };
}
