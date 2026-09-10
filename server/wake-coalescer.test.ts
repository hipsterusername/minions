import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";

import { createBus } from "./bus.ts";
import { SessionHost, type SessionHostDeps } from "./session-host.ts";
import type { TaskRecord } from "./task-tools.ts";
import type { PendingWait, TaskStatus } from "./task-tools/types.ts";
import { cancelQueuedWaitResume } from "./wait-resume.ts";
import {
  buildWakeTaskDigest,
  isWakeWorthyStatus,
  MIN_WAKE_RESUME_INTERVAL_MS,
  requestCoalescedWake,
  WAKE_COALESCE_WINDOW_MS,
  WAKE_DIGEST_EXCERPT_CHARS,
} from "./wake-coalescer.ts";
import { ensureWaitCohort, isWaitCohortSatisfied } from "./leader-wake.ts";

function task(status: TaskStatus, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    title: "Task",
    description: "",
    priority: "medium",
    executor: "minion",
    minionSessionKey: "m-1",
    leaderSessionKey: "leader-1",
    status,
    createdAt: 1,
    completedAt: null,
    result: null,
    ...over,
  };
}

function makeDeps(startChildSession = vi.fn()): SessionHostDeps {
  return {
    bus: createBus({ clients: new Set() } as unknown as WebSocketServer),
    startChildSession,
    forEachLeaderTaskState: () => {},
  };
}

function makeLeader(): SessionHost {
  const host = new SessionHost("leader-1", "/tmp/work");
  host.status = "idle";
  host.role = "leader";
  host.sessionId = "sdk-1";
  return host;
}

function wake(host: SessionHost, deps: SessionHostDeps, prompt: string, immediate = false): void {
  requestCoalescedWake(host, deps, {
    immediate,
    opts: {
      sessionKey: host.id,
      prompt,
      cwd: host.cwd,
      resumeId: host.sessionId ?? undefined,
      role: host.role,
      harness: host.harnessName,
    },
  });
}

describe("wake coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("preserves attention while a leader stays busy longer than the retry budget", async () => {
    const deps = makeDeps();
    deps.resumeWorkItemRun = vi.fn().mockResolvedValue(undefined);
    const host = makeLeader();
    host.workItemId = "work-1";
    host.status = "running";
    const delivered = vi.fn();
    requestCoalescedWake(host, deps, {
      immediate: true, idempotencyKey: "long-active-turn", onDelivered: delivered,
      opts: { sessionKey: host.id, cwd: host.cwd, prompt: "A child needs attention" },
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(deps.resumeWorkItemRun).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    host.status = "idle";
    await vi.advanceTimersByTimeAsync(MIN_WAKE_RESUME_INTERVAL_MS);
    expect(deps.resumeWorkItemRun).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("coalesces multiple wake triggers inside the window into one resume", async () => {
    const startChildSession = vi.fn();
    const deps = makeDeps(startChildSession);
    const host = makeLeader();

    wake(host, deps, "Task results:\nt1 - completed - first");
    await vi.advanceTimersByTimeAsync(1_000);
    wake(host, deps, "Task results:\nt2 - failed - second");

    await vi.advanceTimersByTimeAsync(WAKE_COALESCE_WINDOW_MS - 1_001);
    expect(startChildSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(startChildSession).toHaveBeenCalledOnce();
    const prompt = startChildSession.mock.calls[0]![0].prompt;
    expect(prompt).toContain("Wake event 1");
    expect(prompt).toContain("t1 - completed - first");
    expect(prompt).toContain("Wake event 2");
    expect(prompt).toContain("t2 - failed - second");
  });

  it("defers triggers inside the per-session minimum resume interval", async () => {
    const startChildSession = vi.fn();
    const deps = makeDeps(startChildSession);
    const host = makeLeader();

    wake(host, deps, "first", true);
    expect(startChildSession).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    wake(host, deps, "second", true);
    expect(startChildSession).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(MIN_WAKE_RESUME_INTERVAL_MS - 1_001);
    expect(startChildSession).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(startChildSession).toHaveBeenCalledTimes(2);
    expect(startChildSession.mock.calls[1]![0].prompt).toBe("second");
  });

  it("routes a bound primary wake through the canonical resume seam", () => {
    const startChildSession = vi.fn();
    const deps = makeDeps(startChildSession);
    deps.resumeWorkItemRun = vi.fn();
    const host = makeLeader(); host.workItemId = "work-1"; host.runKind = "primary";
    wake(host, deps, "canonical", true);
    expect(deps.resumeWorkItemRun).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "work-1", runKey: "leader-1", prompt: "canonical",
    }));
    expect(startChildSession).not.toHaveBeenCalled();
  });

  it("handles a rejected primary wake resume without an unhandled rejection", async () => {
    const error = new Error("run is not the current open primary");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    deps.resumeWorkItemRun = vi.fn().mockRejectedValue(error);
    const host = makeLeader(); host.workItemId = "work-1"; host.runKind = "primary";

    wake(host, deps, "stale wake", true);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("work_item_resume_failed"),
      expect.objectContaining({ workItemId: "work-1", runKey: "leader-1" }),
    );
  });

  it("handles a synchronous primary wake resume failure", () => {
    const error = new Error("resume adapter failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    deps.resumeWorkItemRun = vi.fn(() => { throw error; });
    const host = makeLeader(); host.workItemId = "work-1"; host.runKind = "primary";

    expect(() => wake(host, deps, "failed wake", true)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("work_item_resume_failed"),
      expect.objectContaining({ workItemId: "work-1", runKey: "leader-1" }),
    );
  });

  it("cleans up a deferred wake through the termination cleanup path", async () => {
    const startChildSession = vi.fn();
    const deps = makeDeps(startChildSession);
    const host = makeLeader();

    wake(host, deps, "first", true);
    await vi.advanceTimersByTimeAsync(1_000);
    wake(host, deps, "second", true);
    cancelQueuedWaitResume(host);

    await vi.advanceTimersByTimeAsync(MIN_WAKE_RESUME_INTERVAL_MS);

    expect(startChildSession).toHaveBeenCalledOnce();
    expect(startChildSession.mock.calls[0]![0].prompt).toBe("first");
  });

  it("deduplicates an in-flight keyed wake and fences late failure after cancellation", async () => {
    const deps = makeDeps();
    let reject!: (error: unknown) => void;
    deps.resumeWorkItemRun = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const host = makeLeader(); host.workItemId = "work-1"; host.runKind = "primary";
    const request = { immediate: true, idempotencyKey: "same", opts: {
      sessionKey: host.id, cwd: host.cwd, prompt: "once",
    } };
    for (let i = 0; i < 1000; i++) requestCoalescedWake(host, deps, request);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resumeWorkItemRun).toHaveBeenCalledOnce();
    cancelQueuedWaitResume(host);
    reject(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deps.resumeWorkItemRun).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never dispatches or acknowledges obsolete canonical wakes", async () => {
    const deps = makeDeps();
    deps.resumeWorkItemRun = vi.fn();
    deps.wakeDelivery = { eligibility: () => "obsolete", get: () => undefined, put: vi.fn() };
    const host = makeLeader(); host.workItemId = "work-1"; host.runKind = "primary";
    const onDelivered = vi.fn();
    requestCoalescedWake(host, deps, { immediate: true, onDelivered, opts: {
      sessionKey: host.id, cwd: host.cwd, prompt: "old",
    } });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deps.resumeWorkItemRun).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a bounded local receipt for a synchronously delivered keyed wake", async () => {
    const deps = makeDeps(); const host = makeLeader();
    for (let i = 0; i < 1000; i++) requestCoalescedWake(host, deps, {
      immediate: true, idempotencyKey: "one-event", opts: { sessionKey: host.id, cwd: host.cwd, prompt: "once" },
    });
    await vi.runAllTimersAsync();
    expect(deps.startChildSession).toHaveBeenCalledOnce();
  });

  it("lets an immediate event advance the coalescing window", () => {
    const deps = makeDeps(); const host = makeLeader();
    wake(host, deps, "ordinary"); wake(host, deps, "urgent", true);
    expect(deps.startChildSession).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.startChildSession).mock.calls[0]![0].prompt).toContain("urgent");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps each task digest excerpt with a truncation marker", () => {
    const longResult = "x".repeat(WAKE_DIGEST_EXCERPT_CHARS + 50);
    const task: TaskRecord = {
      taskId: "t1",
      title: "Task",
      description: "",
      priority: "medium",
      executor: "minion",
      minionSessionKey: "minion-1",
      leaderSessionKey: "leader-1",
      status: "completed",
      createdAt: 1,
      completedAt: 2,
      result: longResult,
    };

    const digest = buildWakeTaskDigest([task]);

    expect(digest).toContain("x".repeat(WAKE_DIGEST_EXCERPT_CHARS));
    expect(digest).toContain("[truncated]");
    expect(digest).not.toContain("x".repeat(WAKE_DIGEST_EXCERPT_CHARS + 1));
  });

  it("treats terminal and blocked statuses as wake-worthy", () => {
    for (const status of [
      "completed",
      "failed",
      "ended_without_report",
      "cancelled",
      "orphaned",
      "blocked",
    ] as TaskStatus[]) {
      expect(isWakeWorthyStatus(status)).toBe(true);
    }
  });

  it("does not treat in-flight statuses as wake-worthy", () => {
    for (const status of ["planned", "starting", "running"] as TaskStatus[]) {
      expect(isWakeWorthyStatus(status)).toBe(false);
    }
  });

  it("freezes wait membership and does not count blocked as join success", () => {
    const state = {
      tasks: new Map([
        ["blocked", task("blocked", { taskId: "blocked" })],
        ["running", task("running", { taskId: "running" })],
      ]),
      pendingWait: null,
      approval: null,
    };
    const wait: PendingWait = {
      durationMs: 1_000,
      reason: "join",
      scheduledAt: 1,
      timerId: null,
      wakeOn: "all_terminal" as const,
    };

    const cohort = ensureWaitCohort(state, wait);
    state.tasks.set("later", task("completed", { taskId: "later" }));

    expect(wait.taskIds).toEqual(["blocked", "running"]);
    expect(isWaitCohortSatisfied(cohort, "all_terminal")).toBe(false);
    expect(ensureWaitCohort(state, wait).map((entry) => entry.taskId)).toEqual([
      "blocked",
      "running",
    ]);
  });

  it("includes blocked questions regardless of the completion window", () => {
    expect(
      buildWakeTaskDigest([
        task("blocked", { taskId: "b1", lastStep: "Which DB driver?" }),
      ], 10_000),
    ).toBe("b1 — blocked — Which DB driver?");
  });

  it("filters terminal results by completion time", () => {
    expect(
      buildWakeTaskDigest([
        task("completed", { taskId: "c1", result: "done", completedAt: 5_000 }),
        task("completed", { taskId: "c2", result: "later", completedAt: 20_000 }),
      ], 10_000),
    ).toBe("c2 — completed — later");
  });

  it("combines blocked questions and terminal results", () => {
    expect(
      buildWakeTaskDigest([
        task("blocked", { taskId: "b1", lastStep: "stuck" }),
        task("failed", { taskId: "f1", result: "boom", completedAt: 50 }),
      ]),
    ).toBe("b1 — blocked — stuck\nf1 — failed — boom");
  });
});
