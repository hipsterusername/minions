import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "../bus.ts";
import { createPlanTaskToolDef } from "./plan-task.ts";
import { createCompleteTaskToolDef } from "./complete-task.ts";
import type { TaskManagerState, TaskToolContext } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

function makeCtx(): TaskToolContext & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
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
    sent,
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

describe("complete_task", () => {
  it("rejects garbage input before touching task state — parse guard", async () => {
    const ctx = makeCtx();
    const tool = createCompleteTaskToolDef(ctx);

    // Null and empty object both lack required fields.
    await expect(call(tool, null)).rejects.toThrow();
    await expect(call(tool, {})).rejects.toThrow();
    // 'result' must be a string — a number is invalid.
    await expect(call(tool, { taskId: "t1", result: 42 })).rejects.toThrow();

    expect(ctx.taskState.tasks.size).toBe(0);
  });

  it("marks a planned task as completed with the supplied result", async () => {
    const ctx = makeCtx();
    const planTool = createPlanTaskToolDef(ctx);
    const completeTool = createCompleteTaskToolDef(ctx);

    await call(planTool, {
      taskId: "t1",
      title: "T1",
      description: "",
      priority: "medium",
    });
    ctx.sent.length = 0; // discard the plan_task emission

    await call(completeTool, { taskId: "t1", result: "shipped" });

    const record = ctx.taskState.tasks.get("t1")!;
    expect(record.status).toBe("completed");
    expect(record.result).toBe("shipped");
    expect(record.completedAt).toBeTypeOf("number");
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!["type"]).toBe("task_plan_update");
  });

  it("accepts long results without truncating storage", async () => {
    const ctx = makeCtx();
    const planTool = createPlanTaskToolDef(ctx);
    const completeTool = createCompleteTaskToolDef(ctx);
    const longResult = "long-result\n".repeat(500);

    await call(planTool, {
      taskId: "t1",
      title: "T1",
      description: "",
      priority: "medium",
    });
    await call(completeTool, { taskId: "t1", result: longResult });

    expect(ctx.taskState.tasks.get("t1")!.result).toBe(longResult);
  });

  it("describes the summary-first artifact-file convention", () => {
    const ctx = makeCtx();
    const tool = createCompleteTaskToolDef(ctx);

    expect(tool.description).toContain("summary-first");
    expect(tool.description).toContain("artifact file");
  });

  it("rejects unknown taskIds without creating a phantom record", async () => {
    const ctx = makeCtx();
    const tool = createCompleteTaskToolDef(ctx);

    expect(ctx.taskState.tasks.has("rogue")).toBe(false);
    const result = await call(tool, { taskId: "rogue", result: "done" });

    expect(ctx.taskState.tasks.has("rogue")).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("rogue");
  });

  it("is a no-op for an already-completed task — does not overwrite the prior result or fire another emission", async () => {
    const ctx = makeCtx();
    const planTool = createPlanTaskToolDef(ctx);
    const tool = createCompleteTaskToolDef(ctx);
    await call(planTool, {
      taskId: "t1",
      title: "T1",
      description: "",
      priority: "medium",
    });
    await call(tool, { taskId: "t1", result: "first" });
    ctx.sent.length = 0;

    const result = await call(tool, { taskId: "t1", result: "second" });

    expect(ctx.taskState.tasks.get("t1")!.result).toBe("first");
    expect(ctx.sent).toHaveLength(0);
    // The text response acks the no-op; assert only that it references the
    // taskId (avoid pinning literal copy per §5.7).
    expect(result.content[0]!.text).toContain("t1");
  });

  it("rejects leader completion while a delegated child is still attached", async () => {
    const ctx = makeCtx();
    const completeTool = createCompleteTaskToolDef(ctx);

    ctx.taskState.tasks.set("t1", {
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
    });

    const result = await call(completeTool, { taskId: "t1", result: "leader-finished-it" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Cancel it before completing");
    expect(ctx.taskState.tasks.get("t1")!.status).toBe("running");
    expect(ctx.taskState.tasks.get("t1")!.executor).toBe("minion");
  });
});
