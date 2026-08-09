import { describe, expect, it } from "vitest";

import { cloneLeaderContextEdges, cloneLeaderSetupData } from "./leader-setup-clone.ts";
import type { GraphEdge } from "./graph.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";

function leader(overrides: Partial<LeaderData> = {}): LeaderData {
  return {
    sessionKey: "leader-live",
    status: "running",
    messages: [{ id: "m1", role: "user", content: "do work", timestamp: 1 }],
    streamingText: "partial",
    streamingBlockIndex: 0,
    totalCost: 1.23,
    turns: 4,
    error: "boom",
    fullError: "stack",
    model: "claude-opus-4-7",
    harness: "claude",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...DEFAULT_THINKING_CONFIG, effort: "xhigh" },
    taskPlan: [
      {
        taskId: "t1",
        title: "Task",
        description: "Task",
        priority: "high",
        status: "running",
        executor: "minion",
        minionSessionKey: "minion-1",
        result: null,
        cost: 0,
        createdAt: 1,
        completedAt: null,
        sessionSummary: "",
      },
    ],
    worktreeIsolation: true,
    worktreePath: "/tmp/worktree",
    worktreeBranch: "branch",
    worktreeStatus: "active",
    skillIds: ["review"],
    skillValues: { review: { scope: "api" } },
    skillPanelOpen: true,
    autoStartPrompt: "start",
    taskName: "Live session",
    waitUntil: 123,
    waitReason: "waiting",
    ...overrides,
  };
}

describe("cloneLeaderSetupData", () => {
  it("keeps leader setup while clearing runtime conversation state", () => {
    const cloned = cloneLeaderSetupData(leader());

    expect(cloned).toMatchObject({
      sessionKey: null,
      status: "disconnected",
      messages: [],
      streamingText: "",
      totalCost: 0,
      turns: 0,
      error: null,
      model: "claude-opus-4-7",
      harness: "claude",
      permissionMode: "bypassPermissions",
      worktreeIsolation: true,
      worktreePath: null,
      worktreeBranch: null,
      worktreeStatus: "none",
      skillIds: ["review"],
      skillPanelOpen: true,
      taskPlan: [],
      waitUntil: null,
      waitReason: null,
    });
    expect(cloned.skillValues).toEqual({ review: { scope: "api" } });
    expect(cloned).not.toHaveProperty("autoStartPrompt");
    expect(cloned).not.toHaveProperty("taskName");
  });

  it("deep-copies mutable setup fields", () => {
    const source = leader();
    const cloned = cloneLeaderSetupData(source);

    cloned.skillIds.push("docs");
    cloned.skillValues["review"]!["scope"] = "frontend";

    expect(source.skillIds).toEqual(["review"]);
    expect(source.skillValues["review"]!["scope"]).toBe("api");
  });
});

describe("cloneLeaderContextEdges", () => {
  it("copies only incoming context edges to the new leader", () => {
    const edges: GraphEdge[] = [
      {
        id: "ctx",
        sourceNodeId: "markdown-1",
        sourcePortId: "context-out",
        targetNodeId: "leader-1",
        targetPortId: "context-in",
        protocol: "context",
      },
      {
        id: "task",
        sourceNodeId: "leader-1",
        sourcePortId: "task-out",
        targetNodeId: "minion-1",
        targetPortId: "task-in",
        protocol: "task-assignment",
      },
      {
        id: "other",
        sourceNodeId: "markdown-2",
        sourcePortId: "context-out",
        targetNodeId: "leader-2",
        targetPortId: "context-in",
        protocol: "context",
      },
    ];

    const cloned = cloneLeaderContextEdges(edges, "leader-1", "leader-new", () => "edge-new");

    expect(cloned).toEqual([
      {
        id: "edge-new",
        sourceNodeId: "markdown-1",
        sourcePortId: "context-out",
        targetNodeId: "leader-new",
        targetPortId: "context-in",
        protocol: "context",
      },
    ]);
  });
});
