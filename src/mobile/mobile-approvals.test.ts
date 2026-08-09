import { describe, expect, it } from "vitest";

import type { ServerMessage, SessionInfo } from "../use-socket.ts";
import {
  approvalsBadgeCount,
  fileStatusSymbol,
  formatDiffStat,
  pendingApprovalsList,
  reduceApprovalMessage,
  type DetailedDiff,
  type PendingApprovalsMap,
} from "./mobile-approvals.ts";

const diff: DetailedDiff = {
  filesChanged: 2,
  insertions: 12,
  deletions: 3,
  files: [
    { file: "src/a.ts", insertions: 10, deletions: 1, status: "modified" },
    { file: "src/b.ts", insertions: 2, deletions: 2, status: "added" },
  ],
  commits: ["Refactor auth"],
  branch: "worktree/s-1",
};

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: "idle",
    cwd: "/tmp/project",
    ...overrides,
  };
}

describe("mobile approvals", () => {
  it("adds an approval_requested event", () => {
    const next = reduceApprovalMessage({}, {
      type: "approval_requested",
      sessionKey: "s-1",
      summary: "Ready",
      diff,
      timestamp: 10,
      graceUntil: 20,
    });

    expect(next["s-1"]).toMatchObject({
      sessionKey: "s-1",
      summary: "Ready",
      graceUntil: 20,
      diff,
    });
  });

  it("clears pending approval events when resolved, merged, or completed", () => {
    const initial: PendingApprovalsMap = {
      "s-1": { sessionKey: "s-1", summary: "Ready" },
    };

    const resolved: ServerMessage = {
      type: "approval_resolved",
      sessionKey: "s-1",
      action: "requested_changes",
      timestamp: 10,
    };
    expect(reduceApprovalMessage(initial, resolved)).toEqual({});

    expect(reduceApprovalMessage(initial, { type: "worktree_merged", sessionKey: "s-1" })).toEqual({});
    expect(reduceApprovalMessage(initial, {
      type: "session_completed",
      sessionKey: "s-1",
      reason: "done",
      timestamp: 11,
    })).toEqual({});
  });

  it("seeds and clears from sync_response.approval", () => {
    const seeded = reduceApprovalMessage({}, {
      type: "sync_response",
      sessionKey: "s-2",
      found: true,
      approval: {
        requested: true,
        summary: "Review sync",
        diff,
        graceUntil: 99,
      },
    });

    expect(seeded["s-2"]).toMatchObject({
      sessionKey: "s-2",
      summary: "Review sync",
      graceUntil: 99,
      diff,
    });

    expect(reduceApprovalMessage(seeded, {
      type: "sync_response",
      sessionKey: "s-2",
      found: true,
      approval: { requested: false },
    })).toEqual({});
  });

  it("derives badge counts, joined titles, diff stats, and symbols", () => {
    const map: PendingApprovalsMap = {
      "s-1": { sessionKey: "s-1", summary: "Ready", diff },
    };

    expect(approvalsBadgeCount(map)).toBe(1);
    expect(pendingApprovalsList(map, [session({ sessionKey: "s-1", taskName: "Ship mobile" })]))
      .toEqual([{ sessionKey: "s-1", summary: "Ready", diff, sessionTitle: "Ship mobile" }]);
    expect(formatDiffStat(diff)).toBe("2 files +12 -3");
    expect(formatDiffStat({ ...diff, filesChanged: 1 })).toBe("1 file +12 -3");
    expect(fileStatusSymbol("renamed")).toBe(">");
  });
});
