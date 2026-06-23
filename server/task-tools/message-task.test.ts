/**
 * message_task — injects a steering turn into a live minion session and
 * rejects when the session is not live. Mocks at the session boundary
 * (ctx.messageSession); does not exercise the real resume path.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "../bus.ts";
import { createMessageTaskToolDef } from "./message-task.ts";
import type { TaskManagerState, TaskRecord, TaskToolContext } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

interface MessageCall {
  sessionKey: string;
  message: string;
}

function makeCtx(
  outcome: { delivered: boolean; status: string | null } = {
    delivered: true,
    status: "idle",
  },
): TaskToolContext & { messaged: MessageCall[] } {
  const messaged: MessageCall[] = [];
  const client = { readyState: 1, send() {} };
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
    messageSession: (sessionKey, message) => {
      messaged.push({ sessionKey, message });
      return outcome;
    },
    messaged,
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

function seed(ctx: ReturnType<typeof makeCtx>, over: Partial<TaskRecord> = {}): void {
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
    ...over,
  });
}

describe("message_task", () => {
  it("rejects garbage input before touching session state — parse guard", async () => {
    const ctx = makeCtx();
    const tool = createMessageTaskToolDef(ctx);

    await expect(call(tool, null)).rejects.toThrow();
    await expect(call(tool, {})).rejects.toThrow();
    await expect(call(tool, { taskId: "t1", message: 7 })).rejects.toThrow();

    expect(ctx.messaged).toHaveLength(0);
  });

  it("delivers the message to the live minion session without changing task status", async () => {
    const ctx = makeCtx({ delivered: true, status: "running" });
    seed(ctx);
    const tool = createMessageTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", message: "focus on the parser" });

    expect(ctx.messaged).toEqual([
      { sessionKey: "m-1", message: "focus on the parser" },
    ]);
    expect(result.isError).toBeFalsy();
    // Status is untouched.
    expect(ctx.taskState.tasks.get("t1")!.status).toBe("running");
  });

  it("un-blocks a blocked task back to running when the message is delivered", async () => {
    const ctx = makeCtx({ delivered: true, status: "idle" });
    seed(ctx, { status: "blocked", lastStep: "which approach?" });
    const tool = createMessageTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", message: "use approach B" });

    expect(result.isError).toBeFalsy();
    expect(ctx.messaged).toEqual([{ sessionKey: "m-1", message: "use approach B" }]);
    // Answering the blocked minion moves it back into running.
    expect(ctx.taskState.tasks.get("t1")!.status).toBe("running");
  });

  it("keeps a blocked task blocked when its minion session is still running", async () => {
    const ctx = makeCtx({ delivered: false, status: "running" });
    seed(ctx, { status: "blocked", lastStep: "which approach?" });
    const tool = createMessageTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", message: "use approach B" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("still finishing its turn");
    expect(ctx.messaged).toEqual([{ sessionKey: "m-1", message: "use approach B" }]);
    expect(ctx.taskState.tasks.get("t1")!.status).toBe("blocked");
  });

  it("rejects when the session is not live, naming the actual status", async () => {
    const ctx = makeCtx({ delivered: false, status: "completed" });
    seed(ctx);
    const tool = createMessageTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", message: "hello?" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("completed");
  });

  it("rejects unknown taskIds", async () => {
    const ctx = makeCtx();
    const tool = createMessageTaskToolDef(ctx);

    const result = await call(tool, { taskId: "ghost", message: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ghost");
    expect(ctx.messaged).toHaveLength(0);
  });

  it("rejects a task that was never delegated (no minion session)", async () => {
    const ctx = makeCtx();
    seed(ctx, { executor: "leader", minionSessionKey: null, status: "planned" });
    const tool = createMessageTaskToolDef(ctx);

    const result = await call(tool, { taskId: "t1", message: "x" });

    expect(result.isError).toBe(true);
    expect(ctx.messaged).toHaveLength(0);
  });

  it("exposes the expected tool surface (name + required schema)", async () => {
    const ctx = makeCtx();
    const tool = createMessageTaskToolDef(ctx);
    expect(tool.name).toBe("message_task");
    await expect(call(tool, { taskId: "t1" })).rejects.toThrow();
    await expect(call(tool, { message: "x" })).rejects.toThrow();
  });
});
