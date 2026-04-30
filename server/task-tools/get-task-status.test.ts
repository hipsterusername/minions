/**
 * get_task_status — read-only inspection of the task plan.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { createGetTaskStatusTool } from "./get-task-status.ts";
import type { TaskManagerState, TaskToolContext } from "./types.ts";

function makeCtx(): TaskToolContext {
  const wss = { clients: new Set() } as unknown as WebSocketServer;
  return {
    leaderSessionKey: "L",
    bus: createBus(wss),
    startMinionSession: () => {},
    cwd: "/p",
    projectPath: "/p",
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue: () => {},
  };
}

async function call(
  tool: ReturnType<typeof createGetTaskStatusTool>,
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

describe("get_task_status", () => {
  it("returns the JSON-serialised single record when taskId matches", async () => {
    const ctx = makeCtx();
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "high",
      executor: "leader",
      minionSessionKey: null,
      leaderSessionKey: "L",
      status: "running",
      createdAt: 1,
      completedAt: null,
      result: null,
    });

    const tool = createGetTaskStatusTool(ctx);
    const out = await call(tool, { taskId: "t1" });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed).toMatchObject({
      taskId: "t1",
      title: "T",
      priority: "high",
      status: "running",
    });
  });

  it("surfaces a 'not found' message when taskId is unknown", async () => {
    const ctx = makeCtx();
    const tool = createGetTaskStatusTool(ctx);
    const out = await call(tool, { taskId: "ghost" });
    expect(out.content[0]!.text).toContain("ghost");
    expect(out.content[0]!.text.toLowerCase()).toContain("not found");
  });

  it("returns the documented empty-state message when no taskId and no tasks exist", async () => {
    const ctx = makeCtx();
    const tool = createGetTaskStatusTool(ctx);
    const out = await call(tool, {});
    // Don't pin the literal copy (§5.7) — assert structure: not JSON, and
    // mentions "tasks".
    expect(out.content[0]!.text.toLowerCase()).toContain("no tasks");
  });

  it("returns a JSON array of summary records when no taskId is supplied", async () => {
    const ctx = makeCtx();
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T1",
      description: "skip",
      priority: "high",
      executor: "leader",
      minionSessionKey: null,
      leaderSessionKey: "L",
      status: "planned",
      createdAt: 1,
      completedAt: null,
      result: null,
    });
    ctx.taskState.tasks.set("t2", {
      taskId: "t2",
      title: "T2",
      description: "skip",
      priority: "low",
      executor: "minion",
      minionSessionKey: "m-1",
      leaderSessionKey: "L",
      status: "running",
      createdAt: 2,
      completedAt: null,
      result: null,
    });

    const tool = createGetTaskStatusTool(ctx);
    const out = await call(tool, {});
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed).toHaveLength(2);
    // Description is intentionally omitted from the summary; the visible
    // fields are the listing contract.
    expect(parsed[0]).toMatchObject({
      taskId: "t1",
      title: "T1",
      priority: "high",
      status: "planned",
      executor: "leader",
      minionSessionKey: null,
    });
    expect(parsed[0]).not.toHaveProperty("description");
    expect(parsed[1]).toMatchObject({
      taskId: "t2",
      executor: "minion",
      minionSessionKey: "m-1",
    });
  });
});
