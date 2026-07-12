import { describe, expect, it } from "vitest";

import {
  activeMinionSummary,
  activitySection,
  groupSessionsByActivity,
  groupSessionsForTriage,
  compareActivityPriority,
  hasLiveMinions,
  isVisibleInActivity,
  needsAttention,
  sessionBelongsToProject,
  sessionDisplayTitle,
  type MobileSessionInfo,
} from "./mobile-selectors.ts";

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "idle",
    cwd: "/tmp/project",
    ...overrides,
  };
}

function lifecycle(reviewState: NonNullable<MobileSessionInfo["reviewLifecycle"]>["reviewState"], extra = {}) {
  return {
    reviewState,
    reviewReason: null,
    finalReport: null,
    finalDashboardRevision: null,
    dashboardRevision: 0,
    terminalReason: null,
    terminalAt: 1,
    acknowledgedAt: null,
    dismissedAt: null,
    lifecycleRevision: 1,
    ...extra,
  };
}

describe("mobile selectors", () => {
  it("marks error and pending sessions as needing attention", () => {
    expect(needsAttention(session({ status: "error" }))).toBe(true);
    expect(needsAttention(session({ status: "waiting" }))).toBe(true);
    expect(needsAttention(session({ pendingAttention: true }))).toBe(true);
    expect(needsAttention(session({ reviewableChanges: true }))).toBe(true);
    expect(needsAttention(session({ status: "running" }))).toBe(false);
  });

  it("uses the durable lifecycle for attention and visibility", () => {
    const complete = session({ reviewLifecycle: lifecycle("completion_to_review") });
    const acknowledged = session({
      reviewLifecycle: lifecycle("completion_to_review", { acknowledgedAt: 2 }),
    });
    const dismissed = session({
      reviewLifecycle: lifecycle("error_to_review", { dismissedAt: 3 }),
    });
    expect(needsAttention(complete)).toBe(true);
    expect(needsAttention(acknowledged)).toBe(false);
    expect(isVisibleInActivity(dismissed, "open")).toBe(false);
    expect(isVisibleInActivity(dismissed, "dismissed")).toBe(true);
    expect(isVisibleInActivity(dismissed, "all")).toBe(true);
  });

  it("orders lifecycle outcomes before working and acknowledged sessions", () => {
    const sessions = [
      session({ sessionKey: "working", status: "running" }),
      session({ sessionKey: "complete", reviewLifecycle: lifecycle("completion_to_review") }),
      session({ sessionKey: "interrupted", reviewLifecycle: lifecycle("interrupted_to_review") }),
      session({ sessionKey: "error", reviewLifecycle: lifecycle("error_to_review") }),
      session({ sessionKey: "decision", reviewLifecycle: lifecycle("decision_needed") }),
      session({ sessionKey: "read", reviewLifecycle: lifecycle("completion_to_review", { acknowledgedAt: 2 }) }),
    ];
    expect(sessions.sort(compareActivityPriority).map((s) => s.sessionKey)).toEqual([
      "decision", "error", "interrupted", "complete", "working", "read",
    ]);
  });

  it("uses taskName for display title and falls back to sessionKey", () => {
    expect(sessionDisplayTitle(session({ taskName: "Refactor auth" }))).toBe("Refactor auth");
    expect(sessionDisplayTitle(session({ taskName: "   ", sessionKey: "abc" }))).toBe("abc");
    expect(sessionDisplayTitle(session({ sessionKey: "fallback" }))).toBe("fallback");
  });

  it("classifies statuses into activity sections", () => {
    expect(activitySection("running")).toBe("active");
    expect(activitySection("creating")).toBe("active");
    expect(activitySection("waiting")).toBe("active");
    expect(activitySection("idle")).toBe("idle");
    expect(activitySection("error")).toBe("idle");
    expect(activitySection("totally-unknown")).toBe("idle");
    expect(activitySection("stopped")).toBe("stopped");
    expect(activitySection("completed")).toBe("stopped");
    expect(activitySection("disconnected")).toBe("stopped");
  });

  it("groups sessions into Active → Idle → Stopped sections, recent-active first within each", () => {
    const olderRunning = session({ sessionKey: "older-running", status: "running", lastActivityAt: 10 });
    const newerRunning = session({ sessionKey: "newer-running", status: "running", lastActivityAt: 50 });
    const idle = session({ sessionKey: "idle", status: "idle", lastActivityAt: 30 });
    const error = session({ sessionKey: "error", status: "error", lastActivityAt: 99 });
    const stopped = session({ sessionKey: "stopped", status: "stopped", lastActivityAt: 5 });
    const completed = session({ sessionKey: "completed", status: "completed", lastActivityAt: 8 });

    const sections = groupSessionsByActivity([
      olderRunning,
      stopped,
      idle,
      error,
      newerRunning,
      completed,
    ]);

    expect(sections.map((s) => s.id)).toEqual(["active", "idle", "stopped"]);
    expect(sections.map((s) => s.title)).toEqual(["Active", "Idle", "Stopped / Cleared"]);
    // Active: most recently active first.
    expect(sections[0]!.sessions.map((s) => s.sessionKey)).toEqual(["newer-running", "older-running"]);
    // Idle holds idle + error; error is the most recently active here.
    expect(sections[1]!.sessions.map((s) => s.sessionKey)).toEqual(["error", "idle"]);
    // Stopped holds stopped + completed, recent first.
    expect(sections[2]!.sessions.map((s) => s.sessionKey)).toEqual(["completed", "stopped"]);
  });

  it("omits empty sections", () => {
    const sections = groupSessionsByActivity([
      session({ sessionKey: "a", status: "running" }),
      session({ sessionKey: "b", status: "running" }),
    ]);
    expect(sections.map((s) => s.id)).toEqual(["active"]);
  });

  it("scopes sessions to a project by cwd, including worktree subpaths", () => {
    const root = session({ sessionKey: "root", cwd: "/work/alpha" });
    const worktree = session({
      sessionKey: "wt",
      cwd: "/work/alpha/.minions/worktrees/leader-1",
    });
    const sibling = session({ sessionKey: "sibling", cwd: "/work/alpha-beta" });
    const other = session({ sessionKey: "other", cwd: "/work/beta" });

    expect(sessionBelongsToProject(root, "/work/alpha")).toBe(true);
    expect(sessionBelongsToProject(worktree, "/work/alpha")).toBe(true);
    // A sibling whose path merely shares the prefix string must not match.
    expect(sessionBelongsToProject(sibling, "/work/alpha")).toBe(false);
    expect(sessionBelongsToProject(other, "/work/alpha")).toBe(false);
    // Trailing slash on the project path is tolerated.
    expect(sessionBelongsToProject(worktree, "/work/alpha/")).toBe(true);
    // Empty project path never matches.
    expect(sessionBelongsToProject(root, "")).toBe(false);
  });

  it("breaks ties within a section by attention then title", () => {
    const plain = session({ sessionKey: "plain", status: "idle", taskName: "Zeta", lastActivityAt: 0 });
    const flagged = session({ sessionKey: "flagged", status: "idle", taskName: "Alpha", pendingAttention: true, lastActivityAt: 0 });
    const [section] = groupSessionsByActivity([plain, flagged]);
    // Equal lastActivityAt → attention wins over alphabetical order.
    expect(section!.sessions.map((s) => s.sessionKey)).toEqual(["flagged", "plain"]);
  });

  it("orders stopped sessions by most recent response timestamp before title", () => {
    const newer = session({
      sessionKey: "z-new",
      status: "stopped",
      taskName: "Zeta newer",
      lastActivityAt: 300,
    });
    const older = session({
      sessionKey: "a-old",
      status: "completed",
      taskName: "Alpha older",
      lastActivityAt: 100,
    });

    const [section] = groupSessionsByActivity([older, newer]);

    expect(section!.id).toBe("stopped");
    expect(section!.sessions.map((s) => s.sessionKey)).toEqual(["z-new", "a-old"]);
  });

  it("splits attention sessions into a pinned needs-you lane", () => {
    const running = session({ sessionKey: "running", status: "running", lastActivityAt: 20 });
    const error = session({ sessionKey: "error", status: "error", lastActivityAt: 30 });
    const waiting = session({ sessionKey: "waiting", status: "waiting", lastActivityAt: 40 });
    const changes = session({
      sessionKey: "changes",
      status: "idle",
      reviewableChanges: true,
      lastActivityAt: 10,
    });
    const completed = session({ sessionKey: "completed", status: "completed", lastActivityAt: 5 });

    const triage = groupSessionsForTriage([running, error, waiting, changes, completed]);

    expect(triage.needsYou.map((s) => s.sessionKey)).toEqual(["waiting", "error", "changes"]);
    expect(triage.sections.map((s) => s.id)).toEqual(["active", "stopped"]);
    expect(triage.sections[0]!.sessions.map((s) => s.sessionKey)).toEqual(["running"]);
    expect(triage.sections[1]!.sessions.map((s) => s.sessionKey)).toEqual(["completed"]);
  });

  it("summarizes a leader's active minions by live status", () => {
    const summary = activeMinionSummary(
      session({
        role: "leader",
        activeMinions: [
          { taskId: "a", title: "A", status: "running", sessionKey: "m-a" },
          { taskId: "b", title: "B", status: "starting", sessionKey: "m-b" },
          { taskId: "c", title: "C", status: "blocked", sessionKey: "m-c" },
          { taskId: "d", title: "D", status: "planned", sessionKey: "m-d" },
        ],
      }),
    );
    expect(summary).toEqual({ running: 2, blocked: 1, planned: 1, total: 4 });
    expect(hasLiveMinions(summary)).toBe(true);
  });

  it("collapses to zero counts for non-leaders and empty rosters", () => {
    expect(activeMinionSummary(session({ role: "minion", status: "running" }))).toEqual({
      running: 0,
      blocked: 0,
      planned: 0,
      total: 0,
    });
    const empty = activeMinionSummary(session({ role: "leader" }));
    expect(empty).toEqual({ running: 0, blocked: 0, planned: 0, total: 0 });
    expect(hasLiveMinions(empty)).toBe(false);
  });
});
