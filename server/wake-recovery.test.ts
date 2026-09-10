import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakeLeaderFromDurableTaskState } from "./leader-wake.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createWorkItem, getWorkItem, sealWorkItemRun, startWorkItemIteration } from "./work-item-repo.ts";
import { createWakeDeliveryStore, WakeDeliveryError } from "./wake-delivery-store.ts";
import { SessionHost, type SessionHostDeps } from "./session-host.ts";
import { createBus } from "./bus.ts";
import { createSqliteWorkItemService } from "./work-item-service-sqlite.ts";
import { cancelCoalescedWake, getWakeQueueStats, requestCoalescedWake, MAX_PENDING_WAKES, MAX_PENDING_WAKE_BYTES } from "./wake-coalescer.ts";
import { recoverDurableWorkflowState } from "./session-registry-recovery.ts";
import { disablePersistence } from "./session-persist.ts";
import { requestWaitResume } from "./wait-resume.ts";
import { recordRunInvocationIntent, startRunInvocation } from "./work-item-invocations.ts";

function fixture(dbPath = ":memory:") {
  const db = initDb(dbPath); ensureWorkItemSchema(db);
  createWorkItem(db, { id: "work", projectId: "project", projectPath: "/tmp", title: "wake", changeMode: "live", at: 1 });
  startWorkItemIteration(db, { workItemId: "work", runKey: "run", idempotencyKey: "start",
    expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 2 });
  db.prepare("UPDATE work_items SET runtime_state='waiting',wait_kind='timer' WHERE id='work'").run();
  const host = new SessionHost("run", "/tmp");
  host.workItemId = "work"; host.runKind = "primary"; host.role = "leader"; host.status = "stopped";
  host.taskState = { tasks: new Map(), approval: null, pendingWait: {
    scheduledAt: 0, durationMs: 1000, reason: "recover", timerId: null,
  } };
  const deps: SessionHostDeps = { bus: createBus({ clients: new Set() } as never), startChildSession: vi.fn(),
    forEachLeaderTaskState: () => {}, resumeWorkItemRun: vi.fn(), wakeDelivery: createWakeDeliveryStore(db) };
  const request = { allowStopped: true, immediate: true, idempotencyKey: "event", onDelivered: vi.fn(),
    opts: { sessionKey: "run", cwd: "/tmp", prompt: "attention" } };
  const seal = () => {
    const row = getWorkItem(db, "work")!;
    sealWorkItemRun(db, { workItemId: "work", runKey: "run", outcome: "stopped",
      expectedCurrentRunKey: "run", expectedLifecycleRevision: row.lifecycle_revision, at: 3 });
  };
  return { db, host, deps, request, seal };
}
const input = { workItemId: "work", runKey: "run", prompt: "attention", requestId: "event", continuitySource: "system" as const };
function service(f: ReturnType<typeof fixture>, continueRun: () => void | Promise<void>) {
  return createSqliteWorkItemService({ db: f.db, bus: f.deps.bus,
    generateKey: () => "unused", launchRun: () => {}, continueRun });
}
beforeEach(() => { disablePersistence(); vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("durable wake recovery", () => {
  it("drains durable attention beyond the bounded queue without another external wake", async () => {
    const f = fixture(); f.host.status = "idle"; f.host.taskState!.pendingWait = null;
    for (let i = 0; i < MAX_PENDING_WAKES + 8; i++) {
      const task = { taskId: `task-${i}`, title: "result", description: "", priority: "medium" as const,
        executor: "minion" as const, leaderSessionKey: "run", minionSessionKey: `child-${i}`,
        status: "completed" as const, createdAt: 1, completedAt: 2, result: "done",
        attentionRequestedAt: 2, attentionDeliveredAt: null as number | null };
      f.host.taskState!.tasks.set(task.taskId, task);
    }
    wakeLeaderFromDurableTaskState(f.host, f.deps);
    expect(getWakeQueueStats(f.host).count).toBe(MAX_PENDING_WAKES);
    await vi.runAllTimersAsync();
    expect([...f.host.taskState!.tasks.values()].every(task => task.attentionDeliveredAt != null)).toBe(true);
    expect(f.deps.resumeWorkItemRun).toHaveBeenCalledTimes(MAX_PENDING_WAKES + 8);
    expect(getWakeQueueStats(f.host).count).toBe(0);
    f.db.close();
  });

  it.each(["sealed", "superseded", "stop intent", "removed"])("does not recover %s primary waits", async kind => {
    const f = fixture();
    if (kind === "sealed" || kind === "superseded") f.seal();
    if (kind === "superseded") {
      startWorkItemIteration(f.db, { workItemId: "work", runKey: "new", idempotencyKey: "new",
        expectedLifecycleRevision: getWorkItem(f.db, "work")!.lifecycle_revision, expectedCurrentRunKey: "run", at: 4 });
    }
    if (kind === "stop intent") {
      const invocation = startRunInvocation(f.db, { runKey: "run", providerId: "claude", startedAt: 1 });
      recordRunInvocationIntent(f.db, { runKey: "run", providerGeneration: invocation.provider_generation, intent: "stop" });
    }
    if (kind === "removed") f.db.prepare("DELETE FROM sessions WHERE session_key='run'").run();
    const wakeLeader = vi.fn();
    recoverDurableWorkflowState({ sessions: [["run", f.host]], getSession: () => f.host, deps: f.deps, wakeLeader });
    requestCoalescedWake(f.host, f.deps, f.request);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(f.deps.resumeWorkItemRun).not.toHaveBeenCalled(); expect(wakeLeader).not.toHaveBeenCalled();
    expect(f.request.onDelivered).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(f.host.taskState?.pendingWait).not.toBeNull();
    f.db.close();
  });

  it("revalidates a run sealed after enqueue", async () => {
    const f = fixture(); requestCoalescedWake(f.host, f.deps, { ...f.request, immediate: false });
    f.seal(); await vi.runAllTimersAsync();
    expect(f.deps.resumeWorkItemRun).not.toHaveBeenCalled(); expect(f.request.onDelivered).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT state FROM wake_delivery").get()).toEqual({ state: "obsolete" }); f.db.close();
  });

  it("restores a stopped host's legitimate timer wait and acknowledges successful dispatch", async () => {
    const f = fixture(); f.deps.resumeWorkItemRun = async () => {};
    recoverDurableWorkflowState({ sessions: [["run", f.host]], getSession: () => f.host, deps: f.deps, wakeLeader: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.taskState?.pendingWait).toBeNull();
    expect(f.db.prepare("SELECT state FROM wake_delivery").get()).toEqual({ state: "delivered" }); f.db.close();
  });

  it("bounds count and bytes for duplicate and distinct keyed wakes", () => {
    const f = fixture(); f.host.status = "running";
    for (let i = 0; i < 1000; i++) requestCoalescedWake(f.host, f.deps, { ...f.request, immediate: false });
    expect(getWakeQueueStats(f.host).count).toBe(1);
    for (let i = 0; i < 100; i++) requestCoalescedWake(f.host, f.deps, { ...f.request, immediate: false, idempotencyKey: String(i) });
    expect(getWakeQueueStats(f.host).count).toBe(MAX_PENDING_WAKES);
    expect(getWakeQueueStats(f.host).bytes).toBeLessThanOrEqual(MAX_PENDING_WAKE_BYTES);
    cancelCoalescedWake(f.host); expect(vi.getTimerCount()).toBe(0); f.db.close();
  });

  it("persists finite retry exhaustion through a new host/store and retains attention", async () => {
    const f = fixture(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.deps.resumeWorkItemRun = vi.fn().mockRejectedValue(new WakeDeliveryError("transient", "busy"));
    requestCoalescedWake(f.host, f.deps, f.request); await vi.runAllTimersAsync();
    expect(f.deps.resumeWorkItemRun).toHaveBeenCalledTimes(6);
    expect(f.db.prepare("SELECT attempts,state FROM wake_delivery").get()).toEqual({ attempts: 6, state: "failed" });
    const restored = new SessionHost("run", "/tmp"); restored.workItemId = "work"; restored.runKind = "primary";
    f.deps.wakeDelivery = createWakeDeliveryStore(f.db);
    requestCoalescedWake(restored, f.deps, f.request); await vi.runAllTimersAsync();
    expect(f.deps.resumeWorkItemRun).toHaveBeenCalledTimes(6); expect(f.request.onDelivered).not.toHaveBeenCalled();
    expect(f.host.taskState?.pendingWait).not.toBeNull(); expect(vi.getTimerCount()).toBe(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(7); f.db.close();
  });

  it("preserves backoff through recovery and retries an eligible revision conflict once", async () => {
    const f = fixture();
    f.deps.resumeWorkItemRun = vi.fn().mockRejectedValueOnce(Object.assign(new Error("revision"), { code: "conflict" })).mockResolvedValue(undefined);
    requestCoalescedWake(f.host, f.deps, f.request); await Promise.resolve();
    cancelCoalescedWake(f.host);
    const restored = new SessionHost("run", "/tmp"); restored.workItemId = "work"; restored.runKind = "primary";
    requestCoalescedWake(restored, { ...f.deps, wakeDelivery: createWakeDeliveryStore(f.db) }, f.request);
    await vi.advanceTimersByTimeAsync(14_999); expect(f.deps.resumeWorkItemRun).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync(); expect(f.deps.resumeWorkItemRun).toHaveBeenCalledTimes(2);
    expect(f.request.onDelivered).toHaveBeenCalledOnce(); f.db.close();
  });

  it("unknown failures stay visible without retry or successful acknowledgement", async () => {
    const f = fixture(); f.deps.resumeWorkItemRun = vi.fn().mockRejectedValue(new Error("internal defect"));
    requestCoalescedWake(f.host, f.deps, f.request); await vi.runAllTimersAsync();
    expect(f.deps.resumeWorkItemRun).toHaveBeenCalledOnce(); expect(f.request.onDelivered).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT state,reason FROM wake_delivery").get()).toEqual({ state: "failed", reason: "internal defect" }); f.db.close();
  });

  it("late delivery cannot clear a newer wait", async () => {
    const f = fixture(); let resolve!: () => void;
    f.deps.resumeWorkItemRun = () => new Promise<void>(done => { resolve = done; });
    requestWaitResume(f.host, f.deps, { ...f.request, completedReason: "old wait" });
    const next = { ...f.host.taskState!.pendingWait!, scheduledAt: 100 };
    f.host.taskState!.pendingWait = next; resolve(); await Promise.resolve();
    expect(f.host.taskState!.pendingWait).toBe(next); f.db.close();
  });

  it("canonical receipt survives lost acknowledgement and a new service without duplicate dispatch", async () => {
    const f = fixture(); const launch = vi.fn(); const first = service(f, launch);
    await first.resumePrimaryRun(input); // Caller loses this response.
    await service(f, launch).resumePrimaryRun(input);
    expect(launch).toHaveBeenCalledOnce(); f.db.close();
  });

  it("does not falsely acknowledge a busy run; the same request can recover", async () => {
    const f = fixture(); const launch = vi.fn(); const current = service(f, launch);
    current.options.isRunLive = () => true;
    await expect(current.resumePrimaryRun(input)).rejects.toMatchObject({ disposition: "transient" });
    expect(launch).not.toHaveBeenCalled(); current.options.isRunLive = () => false;
    await current.resumePrimaryRun(input); expect(launch).toHaveBeenCalledOnce(); f.db.close();
  });

  it("canonical transient pre-launch failure recovers without sealing the waiting work", async () => {
    const f = fixture(); const launch = vi.fn().mockRejectedValueOnce(new WakeDeliveryError("transient", "adapter busy")).mockResolvedValue(undefined);
    await expect(service(f, launch).resumePrimaryRun(input)).rejects.toMatchObject({ disposition: "transient" });
    await service(f, launch).resumePrimaryRun(input);
    expect(launch).toHaveBeenCalledTimes(2); expect(getWorkItem(f.db, "work")!.outcome).toBe("none"); f.db.close();
  });

  it("uncertain launched invocation is never replayed, including after restart", async () => {
    const f = fixture(); const launch = vi.fn(() => {
      startRunInvocation(f.db, { runKey: "run", providerId: "claude", startedAt: 10, primaryWake: true });
      throw new WakeDeliveryError("transient", "ack lost");
    });
    await expect(service(f, launch).resumePrimaryRun(input)).rejects.toThrow("ack lost");
    await expect(service(f, launch).resumePrimaryRun(input)).rejects.toMatchObject({ disposition: "unknown" });
    expect(launch).toHaveBeenCalledOnce(); f.db.close();
  });

  it("transactional invocation fence rejects sealing between dispatch claim and provider open", async () => {
    const f = fixture(); const provider = vi.fn(); const current = service(f, async () => {
      f.seal();
      startRunInvocation(f.db, { runKey: "run", providerId: "claude", startedAt: 10, primaryWake: true });
      provider();
    });
    await expect(current.resumePrimaryRun(input)).rejects.toThrow("sealed");
    expect(provider).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT count(*) AS n FROM run_invocations").get()).toEqual({ n: 0 }); f.db.close();
  });
  it.each(["stop", "remove"] as const)("fences a late successful dispatch after %s", async reason => {
    const f = fixture(); let resolve!: () => void;
    f.deps.resumeWorkItemRun = () => new Promise<void>(done => { resolve = done; });
    requestCoalescedWake(f.host, f.deps, f.request);
    await f.host.terminate(reason, f.deps);
    if (reason === "remove") f.db.prepare("DELETE FROM sessions WHERE session_key='run'").run();
    resolve(); await Promise.resolve();
    expect(f.request.onDelivered).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(getWakeQueueStats(f.host)).toEqual({ count: 0, bytes: 0, inFlight: false });
    if (reason === "remove") expect(f.db.prepare("SELECT count(*) AS n FROM wake_delivery").get()).toEqual({ n: 0 });
    f.db.close();
  });

  it("keeps a newer blocked report undelivered when an older report is acknowledged", async () => {
    const f = fixture(); f.host.status = "idle"; f.host.taskState!.pendingWait = null;
    const task = { taskId: "task", title: "question", description: "", priority: "medium" as const,
      executor: "minion" as const, leaderSessionKey: "run", minionSessionKey: "child", status: "blocked" as const,
      createdAt: 1, completedAt: null, result: null, lastStep: "old question", attentionRequestedAt: 1,
      attentionDeliveredAt: null as number | null };
    f.host.taskState!.tasks.set(task.taskId, task);
    wakeLeaderFromDurableTaskState(f.host, f.deps);
    task.attentionRequestedAt = 2; task.lastStep = "new question";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(task.attentionDeliveredAt).toBeNull();
    wakeLeaderFromDurableTaskState(f.host, f.deps); await vi.runAllTimersAsync();
    expect(task.attentionDeliveredAt).not.toBeNull(); f.db.close();
  });

  it("retains retry deadlines after closing and reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wake-reopen-")); const path = join(directory, "state.db");
    const f = fixture(path);
    f.deps.resumeWorkItemRun = vi.fn().mockRejectedValueOnce(new WakeDeliveryError("transient", "busy")).mockResolvedValue(undefined);
    requestCoalescedWake(f.host, f.deps, f.request); await Promise.resolve();
    cancelCoalescedWake(f.host); f.db.close();
    const reopened = initDb(path);
    try {
      const host = new SessionHost("run", "/tmp"); host.workItemId = "work"; host.runKind = "primary";
      const deps = { ...f.deps, wakeDelivery: createWakeDeliveryStore(reopened) };
      requestCoalescedWake(host, deps, f.request);
      await vi.advanceTimersByTimeAsync(14_999); expect(deps.resumeWorkItemRun).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync(); expect(deps.resumeWorkItemRun).toHaveBeenCalledTimes(2);
      expect(f.request.onDelivered).toHaveBeenCalledOnce();
    } finally { reopened.close(); rmSync(directory, { recursive: true }); }
  });

});
