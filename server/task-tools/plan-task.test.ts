/**
 * plan_task — adds tasks to ctx.taskState and emits task_plan_update.
 *
 * Boundary: the bus is a real `createBus` over a fake WebSocketServer that
 * captures every fan-out (per docs/testing-strategy.md §5.4).
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "../bus.ts";
import { createPlanTaskTool } from "./plan-task.ts";
import type { TaskManagerState, TaskToolContext } from "./types.ts";

interface CapturedEnvelope {
  topic?: string;
  type?: string;
  [key: string]: unknown;
}

function makeBus(): { bus: Bus; sent: CapturedEnvelope[] } {
  const sent: CapturedEnvelope[] = [];
  const client = {
    readyState: 1,
    send(msg: string) {
      sent.push(JSON.parse(msg) as CapturedEnvelope);
    },
  };
  const wss = { clients: new Set([client]) } as unknown as WebSocketServer;
  return { bus: createBus(wss), sent };
}

function makeCtx(): TaskToolContext & { sent: CapturedEnvelope[] } {
  const { bus, sent } = makeBus();
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

async function callHandler(
  tool: ReturnType<typeof createPlanTaskTool>,
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

describe("plan_task", () => {
  it("registers a new task and emits task_plan_update with the task in the list", async () => {
    const ctx = makeCtx();
    const tool = createPlanTaskTool(ctx);
    await callHandler(tool, {
      taskId: "t1",
      title: "Do the thing",
      description: "More detail",
      priority: "high",
    });

    const record = ctx.taskState.tasks.get("t1");
    expect(record).toMatchObject({
      taskId: "t1",
      title: "Do the thing",
      description: "More detail",
      priority: "high",
      status: "planned",
      executor: "leader",
      result: null,
      completedAt: null,
    });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.type).toBe("task_plan_update");
    expect((ctx.sent[0]!.tasks as Array<{ taskId: string }>)).toEqual([
      expect.objectContaining({ taskId: "t1" }),
    ]);
  });

  it("is idempotent — registering the same taskId twice does NOT replace or reset the existing record", async () => {
    const ctx = makeCtx();
    const tool = createPlanTaskTool(ctx);
    await callHandler(tool, {
      taskId: "t1",
      title: "Original",
      description: "",
      priority: "medium",
    });
    const created = ctx.taskState.tasks.get("t1")!;

    await callHandler(tool, {
      taskId: "t1",
      title: "Replacement",
      description: "x",
      priority: "low",
    });

    const after = ctx.taskState.tasks.get("t1")!;
    expect(after.title).toBe("Original");
    expect(after.priority).toBe("medium");
    expect(after.createdAt).toBe(created.createdAt);
    // The duplicate-register call did not fire another plan update.
    expect(ctx.sent).toHaveLength(1);
  });

  it("fires the onStateChange callback with the live task state on successful add", async () => {
    const ctx = makeCtx();
    const observed: TaskManagerState[] = [];
    ctx.onStateChange = (s) => observed.push(s);
    const tool = createPlanTaskTool(ctx);
    await callHandler(tool, {
      taskId: "x",
      title: "x",
      description: "",
      priority: "low",
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]!.tasks.has("x")).toBe(true);
  });
});
