/**
 * get_task_status — read-only inspection of the task plan.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { createGetTaskStatusToolDef } from "./get-task-status.ts";
import type {
  RuntimeSessionInfo,
  TaskManagerState,
  TaskToolContext,
} from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

function makeRuntime(
  overrides: Partial<RuntimeSessionInfo> = {},
): RuntimeSessionInfo {
  return {
    sessionKey: "m-1",
    sessionId: "sdk-1",
    status: "running",
    role: "minion",
    cwd: "/p",
    model: "sonnet",
    harness: "claude",
    totalCost: 0.25,
    turns: 2,
    isLive: true,
    lastActivityAt: 1000,
    lastActivityAgeMs: 50,
    lastEventType: "sdk_event",
    lastSdkEventKind: "tool_progress",
    lastError: null,
    lastErrorFull: null,
    ...overrides,
  };
}

function makeCtx(
  runtimes: Record<string, RuntimeSessionInfo> = {},
): TaskToolContext {
  const wss = { clients: new Set() } as unknown as WebSocketServer;
  return {
    leaderSessionKey: "L",
    bus: createBus(wss),
    startMinionSession: () => {},
    cwd: "/p",
    projectPath: "/p",
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    getSessionRuntime: (sessionKey) => runtimes[sessionKey] ?? null,
    scheduleWaitContinue: () => {},
  };
}

async function call(
  def: NormalizedToolDef,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await def.handler(args)) as { content: { type: "text"; text: string }[] };
}

describe("get_task_status", () => {
  it("rejects garbage input before reading task state — parse guard", async () => {
    const ctx = makeCtx();
    const tool = createGetTaskStatusToolDef(ctx);

    // Null is not a valid object for the schema.
    await expect(call(tool, null)).rejects.toThrow();
    // taskId must be a string when supplied — a number is invalid.
    await expect(call(tool, { taskId: 42 })).rejects.toThrow();
  });

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

    const tool = createGetTaskStatusToolDef(ctx);
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
    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, { taskId: "ghost" });
    expect(out.content[0]!.text).toContain("ghost");
    expect(out.content[0]!.text.toLowerCase()).toContain("not found");
  });

  it("returns the documented empty-state message when no taskId and no tasks exist", async () => {
    const ctx = makeCtx();
    const tool = createGetTaskStatusToolDef(ctx);
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

    const tool = createGetTaskStatusToolDef(ctx);
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
    });
    expect(parsed[0]).not.toHaveProperty("description");
    // Token-efficiency contract: null fields are elided from the payload, and
    // the JSON is compact (no pretty-print indentation).
    expect(parsed[0]).not.toHaveProperty("minionSessionKey");
    expect(parsed[0]).not.toHaveProperty("result");
    expect(out.content[0]!.text).not.toContain("\n");
    expect(parsed[1]).toMatchObject({
      taskId: "t2",
      executor: "minion",
      minionSessionKey: "m-1",
    });
  });

  it("attaches runtime metadata for a delegated minion task", async () => {
    const ctx = makeCtx({
      "m-1": makeRuntime({
        sessionKey: "m-1",
        isLive: true,
        lastActivityAgeMs: 1234,
      }),
    });
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "high",
      executor: "minion",
      minionSessionKey: "m-1",
      leaderSessionKey: "L",
      status: "running",
      createdAt: 1,
      completedAt: null,
      result: null,
    });

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, { taskId: "t1" });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.runtimeSessionKey).toBe("m-1");
    expect(parsed.runtime).toMatchObject({
      sessionKey: "m-1",
      status: "running",
      role: "minion",
      isLive: true,
      lastActivityAgeMs: 1234,
      lastSdkEventKind: "tool_progress",
    });
  });

  it("uses leader runtime metadata for leader-executed running tasks", async () => {
    const ctx = makeCtx({
      L: makeRuntime({
        sessionKey: "L",
        role: "leader",
        lastEventType: "session_status",
        lastSdkEventKind: null,
      }),
    });
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

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, {});
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed[0]).toMatchObject({
      runtimeSessionKey: "L",
      runtime: {
        sessionKey: "L",
        role: "leader",
        isLive: true,
      },
    });
  });

  // ── summaryView truncation ────────────────────────────

  it("does not truncate result at exactly 200 characters in summary view", async () => {
    const ctx = makeCtx();
    const exactResult = "x".repeat(200);
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "medium",
      executor: "minion",
      minionSessionKey: null,
      leaderSessionKey: "L",
      status: "running",
      createdAt: 1,
      completedAt: null,
      result: exactResult,
    });

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, {});
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed[0].result).toBe(exactResult);
    expect(parsed[0].result).not.toContain("[truncated");
  });

  it("truncates result at 201 characters with the truncation suffix in summary view", async () => {
    const ctx = makeCtx();
    const longResult = "y".repeat(201);
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "medium",
      executor: "minion",
      minionSessionKey: null,
      leaderSessionKey: "L",
      status: "running",
      createdAt: 1,
      completedAt: null,
      result: longResult,
    });

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, {});
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed[0].result).toHaveLength(200 + "… [truncated — fetch taskId for full text]".length);
    expect(parsed[0].result).toMatch(/^y{200}… \[truncated/);
  });

  // ── summaryView runtime nulling for terminal statuses ────────

  it.each(["completed", "failed", "ended_without_report", "cancelled", "orphaned"] as const)(
    "nulls runtime fields in summary view for terminal status '%s'",
    async (terminalStatus) => {
      const ctx = makeCtx({ "m-1": makeRuntime({ sessionKey: "m-1" }) });
      ctx.taskState.tasks.set("t1", {
        taskId: "t1",
        title: "T",
        description: "",
        priority: "medium",
        executor: "minion",
        minionSessionKey: "m-1",
        leaderSessionKey: "L",
        status: terminalStatus,
        createdAt: 1,
        completedAt: 2,
        result: "done",
      });

      const tool = createGetTaskStatusToolDef(ctx);
      const out = await call(tool, {});
      const parsed = JSON.parse(out.content[0]!.text);
      // Null fields are stripped by jsonResult, so the keys should be absent.
      expect(parsed[0]).not.toHaveProperty("runtime");
      expect(parsed[0]).not.toHaveProperty("runtimeSessionKey");
    },
  );

  it("preserves runtime fields in summary view for non-terminal statuses", async () => {
    const ctx = makeCtx({ "m-1": makeRuntime({ sessionKey: "m-1" }) });
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "medium",
      executor: "minion",
      minionSessionKey: "m-1",
      leaderSessionKey: "L",
      status: "running",
      createdAt: 1,
      completedAt: null,
      result: null,
    });

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, {});
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed[0].runtimeSessionKey).toBe("m-1");
    expect(parsed[0].runtime).toMatchObject({ sessionKey: "m-1", isLive: true });
  });

  // ── detailView full fidelity ────────────────────────────

  it("detail view returns full result (untruncated) for a completed task", async () => {
    const ctx = makeCtx({ "m-1": makeRuntime({ sessionKey: "m-1" }) });
    const longResult = "z".repeat(300);
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "medium",
      executor: "minion",
      minionSessionKey: "m-1",
      leaderSessionKey: "L",
      status: "completed",
      createdAt: 1,
      completedAt: 2,
      result: longResult,
    });

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, { taskId: "t1" });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.result).toBe(longResult);
    expect(parsed.result).not.toContain("[truncated");
  });

  it("detail view returns runtime for a completed task", async () => {
    const ctx = makeCtx({ "m-1": makeRuntime({ sessionKey: "m-1", isLive: false }) });
    ctx.taskState.tasks.set("t1", {
      taskId: "t1",
      title: "T",
      description: "",
      priority: "medium",
      executor: "minion",
      minionSessionKey: "m-1",
      leaderSessionKey: "L",
      status: "completed",
      createdAt: 1,
      completedAt: 2,
      result: "done",
    });

    const tool = createGetTaskStatusToolDef(ctx);
    const out = await call(tool, { taskId: "t1" });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.runtimeSessionKey).toBe("m-1");
    expect(parsed.runtime).toMatchObject({ sessionKey: "m-1" });
  });
});
