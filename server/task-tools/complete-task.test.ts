/**
 * complete_task — flips a task to completed, auto-creating the record if
 * the leader didn't pre-plan.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "../bus.ts";
import { createPlanTaskTool } from "./plan-task.ts";
import { createCompleteTaskTool } from "./complete-task.ts";
import type { TaskManagerState, TaskToolContext } from "./types.ts";

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
  tool: ReturnType<typeof createCompleteTaskTool>,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await (
    tool as unknown as {
      handler: (a: unknown, e: unknown) => Promise<{
        content: { type: "text"; text: string }[];
      }>;
    }
  ).handler(args, undefined));
}

describe("complete_task", () => {
  it("marks a planned task as completed with the supplied result", async () => {
    const ctx = makeCtx();
    const planTool = createPlanTaskTool(ctx);
    const completeTool = createCompleteTaskTool(ctx);

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

  it("auto-creates a record when the leader completes an unplanned task", async () => {
    const ctx = makeCtx();
    const tool = createCompleteTaskTool(ctx);

    expect(ctx.taskState.tasks.has("rogue")).toBe(false);
    await call(tool, { taskId: "rogue", result: "done" });

    const record = ctx.taskState.tasks.get("rogue")!;
    expect(record.title).toBe("rogue");
    expect(record.status).toBe("completed");
    expect(record.executor).toBe("leader");
    expect(record.result).toBe("done");
  });

  it("is a no-op for an already-completed task — does not overwrite the prior result or fire another emission", async () => {
    const ctx = makeCtx();
    const tool = createCompleteTaskTool(ctx);
    await call(tool, { taskId: "t1", result: "first" });
    ctx.sent.length = 0;

    const result = await call(tool, { taskId: "t1", result: "second" });

    expect(ctx.taskState.tasks.get("t1")!.result).toBe("first");
    expect(ctx.sent).toHaveLength(0);
    // The text response acks the no-op; assert only that it references the
    // taskId (avoid pinning literal copy per §5.7).
    expect(result.content[0]!.text).toContain("t1");
  });

  it("sets executor='leader' even when the task was previously delegated to a minion", async () => {
    const ctx = makeCtx();
    const completeTool = createCompleteTaskTool(ctx);

    // Seed a task that was delegated.
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

    await call(completeTool, { taskId: "t1", result: "leader-finished-it" });
    expect(ctx.taskState.tasks.get("t1")!.executor).toBe("leader");
  });
});
