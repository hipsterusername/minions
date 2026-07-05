import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { getAgentType } from "./registry.ts";
import { LEADER_SYSTEM_PROMPT } from "./leader.ts";
import { disablePersistence } from "../session-persist.ts";
import type { TaskManagerState } from "../task-tools.ts";
import "./leader.ts";

beforeEach(() => disablePersistence());

describe("leader agent wiring", () => {
  it("documents assign_task executorClass, model override, timeout_minutes, ownedPaths, and retry in delegation guidelines", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("## Token Economy");
    expect(LEADER_SYSTEM_PROMPT).toContain("Buy conclusions, not raw data");
    expect(LEADER_SYSTEM_PROMPT).toContain("over ~2000 chars through their summaries");
    expect(LEADER_SYSTEM_PROMPT).toContain("never Read multi-thousand-line files");
    expect(LEADER_SYSTEM_PROMPT).toContain("executorClass");
    expect(LEADER_SYSTEM_PROMPT).toContain("timeout_minutes");
    expect(LEADER_SYSTEM_PROMPT).toContain("ownedPaths");
    expect(LEADER_SYSTEM_PROMPT).toMatch(/retry|re-assign/i);
    expect(LEADER_SYSTEM_PROMPT).toMatch(/model.*overrides.*executorClass/i);
  });

  it("Wait & Continue section explains early auto-wake and recommends generous durations", () => {
    // The section must explain that the system wakes the leader early when all
    // child tasks finish — so agents use long waits rather than short polling loops.
    expect(LEADER_SYSTEM_PROMPT).toMatch(/auto-wake|wakes you early/i);
    expect(LEADER_SYSTEM_PROMPT).toMatch(/10.{1,5}30 min/i);
    // The old 60-second example must no longer appear.
    expect(LEADER_SYSTEM_PROMPT).not.toMatch(/wait_and_continue.*60 seconds/i);
  });

  it("exposes task and render tools to leader sessions", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const result = getAgentType("leader").getToolGroups({
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession: vi.fn(),
      scheduleWaitContinue: vi.fn(),
    });

    expect(Object.keys(result.toolGroups).sort()).toEqual([
      "render-dashboard",
      "task-manager",
    ]);
    expect(result.mcpToolNames).toContain("mcp__task-manager__plan_task");
    expect(result.mcpToolNames).toContain("mcp__render-dashboard__render_set");
  });

  // Regression (2026-06): the child-task sweep used to live in `onComplete`,
  // which fires on EVERY `done` event — i.e. every time the leader ends a
  // turn. Assigning minions and then pausing (wait_and_continue) aborted all
  // running minions the moment the leader's turn completed. The sweep now
  // lives in `onTerminate`, gated to close/remove.
  it("does not cancel running child tasks when a leader run completes", () => {
    expect(getAgentType("leader").onComplete).toBeUndefined();
  });

  it("keeps children running when the leader is merely stopped or its run aborted", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = makeTaskStateWithChildren();
    const terminations: Array<[string, string]> = [];
    const ctx = {
      sessionKey: "leader-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      terminateSession: (sessionKey: string, reason: string) =>
        terminations.push([sessionKey, reason]),
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    getAgentType("leader").onTerminate?.(ctx, "stop");
    getAgentType("leader").onTerminate?.(ctx, "abort");

    expect(taskState.tasks.get("running-child")?.status).toBe("running");
    expect(terminations).toEqual([]);
  });

  it("cancels unfinished child tasks when the leader session is closed or removed", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const envelopes: Array<Record<string, unknown>> = [];
    bus.subscribe((envelope) => envelopes.push(envelope));
    const taskState = makeTaskStateWithChildren();
    const terminations: Array<[string, string]> = [];

    getAgentType("leader").onTerminate?.(
      {
        sessionKey: "leader-1",
        cwd: "/tmp/project",
        bus,
        worktreeInfo: null,
        worktreeIsolation: false,
        terminateSession: (sessionKey: string, reason: string) =>
          terminations.push([sessionKey, reason]),
        forEachLeaderTaskState: (
          fn: (leaderKey: string, state: TaskManagerState) => void,
        ) => fn("leader-1", taskState),
      },
      "remove",
    );

    expect(taskState.tasks.get("running-child")?.status).toBe("cancelled");
    expect(taskState.tasks.get("done-child")?.status).toBe("completed");
    expect(terminations).toEqual([["minion-1", "abort"]]);
    expect(envelopes.some((e) => e.type === "task_plan_update")).toBe(true);
  });
});

function makeTaskStateWithChildren(): TaskManagerState {
  return {
    tasks: new Map([
      [
        "running-child",
        {
          taskId: "running-child",
          title: "Running child",
          description: "",
          priority: "medium" as const,
          executor: "minion" as const,
          minionSessionKey: "minion-1",
          leaderSessionKey: "leader-1",
          status: "running" as const,
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        },
      ],
      [
        "done-child",
        {
          taskId: "done-child",
          title: "Done child",
          description: "",
          priority: "medium" as const,
          executor: "minion" as const,
          minionSessionKey: "minion-2",
          leaderSessionKey: "leader-1",
          status: "completed" as const,
          createdAt: Date.now(),
          completedAt: Date.now(),
          result: "ok",
        },
      ],
    ]),
    pendingWait: null,
    approval: null,
  };
}
