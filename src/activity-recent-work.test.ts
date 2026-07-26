import { describe, expect, it } from "vitest";

import { selectRecentAgentWork } from "./activity-recent-work.ts";
import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import type { DisplayMessage } from "./sdk-messages.ts";

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "idle",
    cwd: "/tmp/project",
    ...overrides,
  };
}

function leaderNode(
  id: string,
  data: Partial<LeaderData>,
): CanvasNode {
  return {
    id,
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    data: { sessionKey: null, status: "disconnected", messages: [], ...data },
  };
}

function msg(role: DisplayMessage["role"], content: string, timestamp: number): DisplayMessage {
  return { id: `m-${timestamp}`, role, content, timestamp };
}

describe("selectRecentAgentWork", () => {
  it("returns the newest sessions first, capped at the limit", () => {
    const result = selectRecentAgentWork(
      [
        session({ sessionKey: "a", taskName: "Oldest", lastActivityAt: 1 }),
        session({ sessionKey: "b", taskName: "Newest", lastActivityAt: 4 }),
        session({ sessionKey: "c", taskName: "Mid", lastActivityAt: 3 }),
        session({ sessionKey: "d", taskName: "Older", lastActivityAt: 2 }),
      ],
      [],
    );
    expect(result.map((entry) => entry.title)).toEqual(["Newest", "Mid", "Older"]);
  });

  it("excludes dismissed sessions and does not resurface them via their node", () => {
    const dismissed = session({
      sessionKey: "gone",
      taskName: "Dismissed",
      lastActivityAt: 9,
      reviewLifecycle: {
        reviewState: "completion_to_review",
        reviewReason: "review",
        finalReport: "done",
        finalDashboardRevision: 1,
        dashboardRevision: 1,
        terminalReason: "completed",
        terminalAt: 1,
        acknowledgedAt: null,
        dismissedAt: 5,
        lifecycleRevision: 2,
      },
    });
    const result = selectRecentAgentWork(
      [dismissed, session({ sessionKey: "open", taskName: "Open", lastActivityAt: 1 })],
      [leaderNode("node-gone", { sessionKey: "gone", messages: [msg("assistant", "text", 3)] })],
    );
    expect(result.map((entry) => entry.title)).toEqual(["Open"]);
  });

  it("excludes minions", () => {
    const result = selectRecentAgentWork(
      [
        session({ sessionKey: "m", role: "minion", taskName: "Minion", lastActivityAt: 9 }),
        session({ sessionKey: "l", role: "leader", taskName: "Leader", lastActivityAt: 1 }),
      ],
      [],
    );
    expect(result.map((entry) => entry.title)).toEqual(["Leader"]);
  });

  it("links a session to its canvas node and prefers session metadata", () => {
    const result = selectRecentAgentWork(
      [session({ sessionKey: "run", taskName: "On canvas", lastActivity: "Reading files", lastActivityAt: 5 })],
      [leaderNode("node-run", { sessionKey: "run", messages: [msg("assistant", "Node text", 2)] })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      nodeId: "node-run",
      sessionKey: "run",
      snippet: "Reading files",
      status: "idle",
    });
  });

  it("falls back to the node transcript for sessions without activity text", () => {
    const result = selectRecentAgentWork(
      [session({ sessionKey: "run", taskName: "Quiet", lastActivityAt: 5, cwd: "/tmp/p" })],
      [leaderNode("node-run", { sessionKey: "run", messages: [msg("assistant", "Shipped the fix.", 2)] })],
    );
    expect(result[0]?.snippet).toBe("Shipped the fix.");
  });

  it("surfaces canvas leader nodes when no live session backs them", () => {
    const result = selectRecentAgentWork(
      [],
      [
        leaderNode("node-1", {
          sessionKey: "gone",
          taskName: "Prior work",
          messages: [msg("user", "Do it", 1), msg("assistant", "Done: migrated the schema.", 2)],
        }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Prior work",
      snippet: "Done: migrated the schema.",
      nodeId: "node-1",
      sessionKey: "gone",
      status: null,
      lastActivityAt: 2,
    });
  });

  it("skips blank draft nodes with no transcript and no name", () => {
    const result = selectRecentAgentWork([], [leaderNode("draft", { sessionKey: null })]);
    expect(result).toEqual([]);
  });

  it("prefers the final report as the snippet and truncates long text", () => {
    const long = "x".repeat(400);
    const result = selectRecentAgentWork(
      [
        session({
          sessionKey: "done",
          taskName: "Report",
          lastActivityAt: 1,
          reviewLifecycle: {
            reviewState: "completion_to_review",
            reviewReason: "review",
            finalReport: long,
            finalDashboardRevision: 1,
            dashboardRevision: 1,
            terminalReason: "completed",
            terminalAt: 1,
            acknowledgedAt: null,
            dismissedAt: null,
            lifecycleRevision: 1,
          },
        }),
      ],
      [],
    );
    expect(result[0]?.snippet.length).toBeLessThanOrEqual(160);
    expect(result[0]?.snippet.endsWith("…")).toBe(true);
  });
});
