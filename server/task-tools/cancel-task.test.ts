/**
 * cancel_task — terminates the live minion (if any) and marks the task
 * cancelled. Cancelled tasks remain retryable (see task-lifecycle.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "../bus.ts";
import { createPlanTaskToolDef } from "./plan-task.ts";
import { createCancelTaskToolDef } from "./cancel-task.ts";
import type { TaskManagerState, TaskRecord, TaskToolContext } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

interface TerminateCall {
  sessionKey: string;
  reason: "abort";
}

function makeCtx(): TaskToolContext & {
  sent: Record<string, unknown>[];
  terminated: TerminateCall[];
} {
  const sent: Record<string, unknown>[] = [];
  const terminated: TerminateCall[] = [];
  const client = {
    readyState: 1,
    send(msg: string) {
      sent.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  const wss = { clients: new Set([client]) } as unknown as WebSocketServer;
  const bus: Bus = createBus(wss);
  const taskState: TaskManagerState = {
    tasks: new Map(),
    pendingWait: null,
    approval: null,
  };
  return {
    leaderSessionKey: "leader-1",
    bus,
    startMinionSession: () => {},
    cwd: "/proj",
    projectPath: "/proj",
    minionSystemPrompt: "",
    taskState,
    scheduleWaitContinue: () => {},
    terminateSession: (sessionKey, reason) => {
      terminated.push({ sessionKey, reason });
    },
    sent,
    terminated,
  };
}

async function call(
  def: NormalizedToolDef,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return (await def.handler(args)) as {
    content: { type: "text"; text: string }[];
    isError?: boolean;
  };
}

function seedRunning(ctx: ReturnType<typeof makeCtx>): TaskRecord {
  const record: TaskRecord = {
    taskId: "t1",
    title: "T",
    description: "",
    priority: "medium",
    executor: "minion",
    minionSessionKey: "m-1",
    leaderSessionKey: ctx.leaderSessionKey,
    status: "running",
    createdAt: Date.now(),
    completedAt: null,
    result: null,
  };
  ctx.taskState.tasks.set("t1", record);
  return record;
}

describe("cancel_task", () => {
  it("rejects garbage input before touching task state — parse guard", async () => {
    const ctx = makeCtx();
    const tool = createCancelTaskToolDef(ctx);

    await expect(call(tool, null)).rejects.toThrow();
    await expect(call(tool, {})).rejects.toThrow();
    // 'reason' must be a string.
    await expect(call(tool, { taskId: "t1", reason: 42 })).rejects.toThrow();

    expect(ctx.taskState.tasks.size).toBe(0);
    expect(ctx.terminated).toHaveLength(0);
  });

  it("cancels a running task: kills the live minion session and stores the reason", async () => {
    const ctx = makeCtx();
    seedRunning(ctx);
    const tool = createCancelTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", reason: "leader redirected" });

    const record = ctx.taskState.tasks.get("t1")!;
    expect(record.status).toBe("cancelled");
    expect(record.result).toBe("leader redirected");
    expect(record.completedAt).toBeTypeOf("number");
    expect(ctx.terminated).toEqual([{ sessionKey: "m-1", reason: "abort" }]);
    expect(result.isError).toBeFalsy();
    // Lifecycle change broadcasts a task_plan_update.
    expect(ctx.sent.some((m) => m["type"] === "task_plan_update")).toBe(true);
  });

  it("cancels a planned task with no live session — no terminateSession call", async () => {
    const ctx = makeCtx();
    const planTool = createPlanTaskToolDef(ctx);
    const cancelTool = createCancelTaskToolDef(ctx);

    await call(planTool, {
      taskId: "t1",
      title: "T1",
      description: "",
      priority: "medium",
    });

    await call(cancelTool, { taskId: "t1", reason: "no longer needed" });

    const record = ctx.taskState.tasks.get("t1")!;
    expect(record.status).toBe("cancelled");
    expect(record.result).toBe("no longer needed");
    expect(ctx.terminated).toHaveLength(0);
  });

  it("rejects unknown taskIds without creating a phantom record", async () => {
    const ctx = makeCtx();
    const tool = createCancelTaskToolDef(ctx);

    const result = await call(tool, { taskId: "rogue", reason: "x" });

    expect(ctx.taskState.tasks.has("rogue")).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("rogue");
    expect(ctx.terminated).toHaveLength(0);
  });

  it("is a no-op for an already-terminal task — no kill, no emission", async () => {
    const ctx = makeCtx();
    const record = seedRunning(ctx);
    record.status = "completed";
    record.completedAt = Date.now();
    record.result = "already done";
    ctx.sent.length = 0;
    const tool = createCancelTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", reason: "too late" });

    expect(ctx.taskState.tasks.get("t1")!.status).toBe("completed");
    expect(ctx.taskState.tasks.get("t1")!.result).toBe("already done");
    expect(ctx.terminated).toHaveLength(0);
    expect(ctx.sent).toHaveLength(0);
    expect(result.content[0]!.text).toContain("t1");
  });

  it("exposes the expected tool surface (name + required schema)", async () => {
    const ctx = makeCtx();
    const tool = createCancelTaskToolDef(ctx);
    expect(tool.name).toBe("cancel_task");
    // taskId and reason are both required.
    await expect(call(tool, { taskId: "t1" })).rejects.toThrow();
    await expect(call(tool, { reason: "x" })).rejects.toThrow();
  });
});
