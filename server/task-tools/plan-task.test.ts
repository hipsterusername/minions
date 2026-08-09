/**
 * plan_task — adds tasks to ctx.taskState and emits task_plan_update.
 *
 * The bus is a real `createBus` over a fake WebSocketServer that captures
 * every fan-out.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "../bus.ts";
import { createPlanTaskToolDef } from "./plan-task.ts";
import type { TaskManagerState, TaskToolContext } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import { loadSystemModel } from "../system-model/load.ts";

const FIXTURE_MODEL = loadSystemModel("tests/fixtures/system-model/valid").model!;

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
  def: NormalizedToolDef,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await def.handler(args)) as { content: { type: "text"; text: string }[] };
}

describe("plan_task", () => {
  it("rejects garbage input before touching task state — parse guard", async () => {
    const ctx = makeCtx();
    const tool = createPlanTaskToolDef(ctx);

    // Null and empty objects are invalid — all required fields are missing.
    await expect(callHandler(tool, null)).rejects.toThrow();
    await expect(callHandler(tool, {})).rejects.toThrow();
    // Wrong type for priority enum.
    await expect(
      callHandler(tool, {
        taskId: "t",
        title: "T",
        description: "",
        priority: "URGENT",
      }),
    ).rejects.toThrow();

    expect(ctx.taskState.tasks.size).toBe(0);
  });

  it("registers a new task and emits task_plan_update with the task in the list", async () => {
    const ctx = makeCtx();
    const tool = createPlanTaskToolDef(ctx);
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
    const tool = createPlanTaskToolDef(ctx);
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

  it("appends a packet-required note ONLY when files hit a gated surface (redesign §5)", async () => {
    const ctx = makeCtx();
    ctx.systemModel = FIXTURE_MODEL;
    const tool = createPlanTaskToolDef(ctx);

    const hit = await callHandler(tool, {
      taskId: "hit",
      title: "Touch server",
      description: "",
      priority: "high",
      files: ["server/commands/approve-changes.ts"],
    });
    expect(hit.content[0]!.text).toContain("packetRequired: true");
    expect(hit.content[0]!.text).toContain("gate.review");

    const miss = await callHandler(tool, {
      taskId: "miss",
      title: "Touch src",
      description: "",
      priority: "low",
      files: ["src/App.tsx"],
    });
    expect(miss.content[0]!.text).toBe("Task miss planned.");
  });

  it("stays silent when the task has no files, or when the layer is off", async () => {
    const withModel = makeCtx();
    withModel.systemModel = FIXTURE_MODEL;
    const noFiles = await callHandler(createPlanTaskToolDef(withModel), {
      taskId: "nofiles",
      title: "No files",
      description: "",
      priority: "low",
    });
    expect(noFiles.content[0]!.text).toBe("Task nofiles planned.");

    // Layer off: even gated files produce no note.
    const layerOff = makeCtx();
    const off = await callHandler(createPlanTaskToolDef(layerOff), {
      taskId: "off",
      title: "Gated but layer off",
      description: "",
      priority: "low",
      files: ["server/commands/approve-changes.ts"],
    });
    expect(off.content[0]!.text).toBe("Task off planned.");
  });

  it("fires the onStateChange callback with the live task state on successful add", async () => {
    const ctx = makeCtx();
    const observed: TaskManagerState[] = [];
    ctx.onStateChange = (s) => observed.push(s);
    const tool = createPlanTaskToolDef(ctx);
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
