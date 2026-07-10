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

describe("minion sub-skill tool group", () => {
  function ctxWith(over: Record<string, unknown> = {}) {
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    return {
      sessionKey: "minion-1",
      cwd: "/tmp/worktree",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
      forEachLeaderTaskState: () => {},
      ...over,
    };
  }

  /** ctx whose parent task armed the given skill IDs. */
  function ctxWithArmedSkills(skillIds: string[]) {
    const taskState: TaskManagerState = {
      tasks: new Map([
        [
          "t1",
          {
            taskId: "t1",
            title: "T1",
            description: "",
            priority: "medium" as const,
            executor: "minion" as const,
            minionSessionKey: "minion-1",
            leaderSessionKey: "leader-1",
            status: "running" as const,
            createdAt: 0,
            completedAt: null,
            result: null,
            skillIds,
          },
        ],
      ]),
      pendingWait: null,
      approval: null,
    };
    return ctxWith({
      forEachLeaderTaskState: (
        fn: (leaderKey: string, state: TaskManagerState) => void,
      ) => fn("leader-1", taskState),
    });
  }

  it("omits the authoring tools when the task did not arm skill-builder", () => {
    const minion = getAgentType("minion");
    // ctxWith's forEachLeaderTaskState is a no-op → no parent task at all.
    const { toolGroups, mcpToolNames } = minion.getToolGroups(ctxWith());
    expect(toolGroups["skills"]?.map((t) => t.name)).toEqual(["load_subskill"]);
    expect(mcpToolNames).toContain("mcp__skills__load_subskill");
    expect(mcpToolNames).not.toContain("mcp__skills__create_skill");
    expect(mcpToolNames).not.toContain("mcp__skills__list_skills");
  });

  it("omits the authoring tools when the task armed other skills only", () => {
    const minion = getAgentType("minion");
    const { toolGroups, mcpToolNames } = minion.getToolGroups(
      ctxWithArmedSkills(["code-review"]),
    );
    expect(toolGroups["skills"]?.map((t) => t.name)).toEqual(["load_subskill"]);
    expect(mcpToolNames).not.toContain("mcp__skills__create_skill");
  });

  it("exposes the authoring tools when the task armed skill-builder", () => {
    const minion = getAgentType("minion");
    const { toolGroups, mcpToolNames } = minion.getToolGroups(
      ctxWithArmedSkills(["skill-builder"]),
    );
    expect(toolGroups["skills"]?.map((t) => t.name)).toEqual([
      "load_subskill",
      "list_skills",
      "get_skill",
      "create_skill",
      "update_skill",
      "delete_skill",
    ]);
    expect(mcpToolNames).toContain("mcp__skills__load_subskill");
    expect(mcpToolNames).toContain("mcp__skills__create_skill");
  });

  it("derives projectPath from parentWorktree.projectPath when present", async () => {
    // Pointing projectPath at a temp dir with a skills.json proves the tool
    // reads from parentWorktree.projectPath rather than the worktree cwd.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { writeSkills } = await import("../project-store.ts");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-subskill-"));
    try {
      writeSkills(projectDir, [
        {
          id: "p",
          name: "Parent",
          description: "d",
          category: "general",
          icon: "x",
          accentColor: "#fff",
          template: "base",
          variables: [],
          subskills: [
            { id: "s", name: "Sub", description: "d", body: "MINION BODY" },
          ],
        },
      ]);
      const minion = getAgentType("minion");
      const { toolGroups } = minion.getToolGroups(
        ctxWith({
          cwd: "/tmp/worktree-cwd",
          parentWorktree: { projectPath: projectDir },
        }),
      );
      const def = toolGroups["skills"]!.find((t) => t.name === "load_subskill")!;
      const res = (await def.handler({ skillId: "p", subskillId: "s" })) as {
        content: { type: "text"; text: string }[];
      };
      expect(res.content[0]!.text).toBe("# Sub-skill: Parent › Sub\n\nMINION BODY");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
