import type { SessionInfo } from "../use-socket.ts";

export type MobileSessionInfo = SessionInfo & {
  lastActivity?: string | null;
  lastActivityAt?: number | null;
  pendingAttention?: boolean;
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

export function needsAttention(session: MobileSessionInfo): boolean {
  return session.status === "error" || session.pendingAttention === true;
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
