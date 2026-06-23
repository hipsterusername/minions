import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { disablePersistence } from "../session-persist.ts";
import type { TaskManagerState } from "../task-tools.ts";
import { applyLifecycleEvent, applySessionEndedForMinion } from "../task-lifecycle.ts";
import { getAgentType } from "./registry.ts";
import "./minion.ts";

beforeEach(() => disablePersistence());

function parentTaskState(): TaskManagerState {
  return {
    tasks: new Map([
      [
        "t1",
        {
          taskId: "t1",
          title: "T1",
          description: "",
          priority: "medium",
          executor: "minion",
          minionSessionKey: "minion-1",
          leaderSessionKey: "leader-1",
          status: "running",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        },
      ],
    ]),
    pendingWait: null,
    approval: null,
  };
}

describe("minion task lifecycle", () => {
  it("nudges once on clean minion completion without report_done", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    const minion = getAgentType("minion");
    const startMinionSession = vi.fn();
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    await minion.onComplete?.(ctx, { is_error: false, result: "quiet" });

    const task = taskState.tasks.get("t1");
    expect(task?.status).toBe("running");
    expect(task?.nudgedAt).toEqual(expect.any(Number));
    expect(startMinionSession).toHaveBeenCalledTimes(1);
    expect(startMinionSession).toHaveBeenCalledWith({
      sessionKey: "minion-1",
      prompt:
        "Your task is still open. Call mcp__minion-status__report_done with a one-line summary of what you completed, or report_fail with what blocked you. Do not start new work.",
      cwd: "/tmp/project",
      systemPrompt: expect.any(String),
    });
  });

  it("marks the second silent clean completion after a nudge as ended_without_report", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    taskState.tasks.get("t1")!.nudgedAt = 123;
    const minion = getAgentType("minion");
    const startMinionSession = vi.fn();
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    await minion.onComplete?.(ctx, { is_error: false, result: "quiet again" });

    expect(taskState.tasks.get("t1")?.status).toBe("ended_without_report");
    expect(startMinionSession).not.toHaveBeenCalled();
  });

  it("report_done after a nudge completes normally", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    taskState.tasks.get("t1")!.nudgedAt = 123;
    const minion = getAgentType("minion");
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    const { toolGroups } = minion.getToolGroups(ctx);
    const reportDoneDef = toolGroups["minion-status"]?.find((t) => t.name === "report_done");
    expect(reportDoneDef).toBeDefined();

    await reportDoneDef!.handler({ summary: "finished after nudge" });

    const task = taskState.tasks.get("t1");
    expect(task?.status).toBe("completed");
    expect(task?.result).toBe("finished after nudge");
  });

  it("report_fail after a nudge fails normally", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    taskState.tasks.get("t1")!.nudgedAt = 123;
    const minion = getAgentType("minion");
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    const { toolGroups } = minion.getToolGroups(ctx);
    const reportFailDef = toolGroups["minion-status"]?.find((t) => t.name === "report_fail");
    expect(reportFailDef).toBeDefined();

    await reportFailDef!.handler({ reason: "blocked after nudge" });

    const task = taskState.tasks.get("t1");
    expect(task?.status).toBe("failed");
    expect(task?.result).toBe("blocked after nudge");
  });

  it("does not nudge when timeout or cancellation ends the task", () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const cancelledState = parentTaskState();
    const timedOutState = parentTaskState();
    const startMinionSession = vi.fn();

    applySessionEndedForMinion({
      bus,
      minionSessionKey: "minion-1",
      reason: "abort",
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", cancelledState),
    });
    applyLifecycleEvent({
      bus,
      leaderSessionKey: "leader-1",
      taskState: timedOutState,
      taskId: "t1",
      event: { type: "timeout", result: "timed out" },
    });

    const cancelled = cancelledState.tasks.get("t1");
    const timedOut = timedOutState.tasks.get("t1");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.nudgedAt).toBeUndefined();
    expect(timedOut?.status).toBe("failed");
    expect(timedOut?.nudgedAt).toBeUndefined();
    expect(startMinionSession).not.toHaveBeenCalled();
  });

  it("passes report_step message through to lastStep and increments stepCount", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    const minion = getAgentType("minion");
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    // getToolGroups wires up onReport → applyLifecycleEvent with message
    const { toolGroups } = minion.getToolGroups(ctx);
    const reportStepDef = toolGroups["minion-status"]?.find((t) => t.name === "report_step");
    expect(reportStepDef).toBeDefined();

    await reportStepDef!.handler({ message: "Implementing the feature" });

    const t = taskState.tasks.get("t1");
    expect(t?.lastStep).toBe("Implementing the feature");
    expect(t?.stepCount).toBe(1);
    expect(t?.status).toBe("running");
  });

  it("report_blocked moves the task to the non-terminal blocked status with the question", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    const minion = getAgentType("minion");
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    const { toolGroups } = minion.getToolGroups(ctx);
    const reportBlockedDef = toolGroups["minion-status"]?.find(
      (t) => t.name === "report_blocked",
    );
    expect(reportBlockedDef).toBeDefined();

    await reportBlockedDef!.handler({ question: "Which DB driver should I use?" });

    const t = taskState.tasks.get("t1");
    expect(t?.status).toBe("blocked");
    expect(t?.lastStep).toBe("Which DB driver should I use?");
    expect(t?.completedAt).toBeNull();
  });

  it("does not terminalize a blocked task when the minion's turn ends", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    taskState.tasks.get("t1")!.status = "blocked";
    const minion = getAgentType("minion");
    const startMinionSession = vi.fn();
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      startMinionSession,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    await minion.onComplete?.(ctx, { is_error: false, result: "turn ended" });

    // Stays blocked — awaiting a message_task answer — not ended_without_report.
    expect(taskState.tasks.get("t1")?.status).toBe("blocked");
    expect(startMinionSession).not.toHaveBeenCalled();
  });

  it("report_step accumulates stepCount across multiple calls", async () => {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    const taskState = parentTaskState();
    const minion = getAgentType("minion");
    const ctx = {
      sessionKey: "minion-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    };

    const { toolGroups } = minion.getToolGroups(ctx);
    const reportStepDef = toolGroups["minion-status"]?.find((t) => t.name === "report_step")!;

    await reportStepDef.handler({ message: "step one" });
    await reportStepDef.handler({ message: "step two" });
    await reportStepDef.handler({ message: "step three" });

    const t = taskState.tasks.get("t1");
    expect(t?.stepCount).toBe(3);
    expect(t?.lastStep).toBe("step three");
    expect(t?.status).toBe("running");
  });
});
