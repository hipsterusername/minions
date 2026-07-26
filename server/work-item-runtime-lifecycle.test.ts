import { describe, expect, it, vi } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createBus } from "./bus.ts";
import { createSqliteWorkItemService } from "./work-item-service-sqlite.ts";
import { createWorkItemRuntimeLifecycle } from "./work-item-runtime-lifecycle.ts";

describe("concrete work-item runtime lifecycle", () => {
  it("projects primary init, wait, resume, and exact terminal state while children stay nested", async () => {
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const bus = createBus({ clients: new Set() } as never);
    const service = createSqliteWorkItemService({ db, bus,
      generateKey: (kind, id) => `${kind}-${id}`, launchRun: vi.fn(), continueRun: vi.fn(), now: () => 10 });
    const lifecycle = createWorkItemRuntimeLifecycle({ db, bus, service });
    const draft = await service.create({ requestId: "create", projectId: "p", projectPath: "/repo", title: "T", changeMode: "live" });
    await service.startRun({ requestId: "start", workItemId: draft.workItem.id, prompt: "go", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const identity = { workItemId: draft.workItem.id, runKey: "run-start", runKind: "primary" as const, parentRunKey: null, taskId: null };
    lifecycle.providerInitialized({ ...identity, providerSessionId: "provider", providerGeneration: 1, at: 11 });
    lifecycle.runStarted({ ...identity, at: 12 });
    lifecycle.runStarted({ ...identity, at: 13 });
    lifecycle.runWaiting({ ...identity, waitKind: "decision", at: 14 });
    const waiting = await service.get(draft.workItem.id);
    expect(waiting?.workItem).toMatchObject({ waitKind: "decision", lifecycle: { runtimeState: "waiting" } });
    await service.replyToWaitingRun({ requestId: "reply", workItemId: draft.workItem.id,
      runKey: identity.runKey, prompt: "A", expectedLifecycleRevision: waiting!.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: identity.runKey });
    lifecycle.runStarted({ ...identity, at: 15 });
    lifecycle.runTerminal({ ...identity, outcome: "completed", finalReportId: "report", finalReport: "Done", at: 16 });
    lifecycle.runTerminal({ ...identity, outcome: "completed", finalReportId: "report", finalReport: "Done", at: 17 });
    expect((await service.get(draft.workItem.id))?.workItem.lifecycle.outcome).toBe("completed");
  });

  it("ignores a late provider init after an interrupted run is sealed", async () => {
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const bus = createBus({ clients: new Set() } as never);
    const service = createSqliteWorkItemService({ db, bus,
      generateKey: (kind, id) => `${kind}-${id}`, launchRun: vi.fn(),
      continueRun: vi.fn(), now: () => 10 });
    const lifecycle = createWorkItemRuntimeLifecycle({ db, bus, service });
    const draft = await service.create({ requestId: "create-late", projectId: "p",
      projectPath: "/repo", title: "T", changeMode: "live" });
    await service.startRun({ requestId: "late", workItemId: draft.workItem.id, prompt: "go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const identity = { workItemId: draft.workItem.id, runKey: "run-late",
      runKind: "primary" as const, parentRunKey: null, taskId: null };
    lifecycle.runTerminal({ ...identity, outcome: "interrupted", finalReportId: null,
      finalReport: null, at: 11 });

    expect(() => lifecycle.providerInitialized({ ...identity, providerSessionId: "late-provider",
      providerGeneration: 2, at: 12 })).not.toThrow();
    const run = db.prepare("SELECT session_id, ended_at FROM sessions WHERE session_key = ?")
      .get(identity.runKey) as { session_id: string | null; ended_at: number | null };
    expect(run.session_id).toBeNull();
    expect(run.ended_at).toBe(11);
  });

  it("resumes a waiting primary when checkpoint rollover opens a fresh provider thread", async () => {
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const bus = createBus({ clients: new Set() } as never);
    const service = createSqliteWorkItemService({ db, bus,
      generateKey: (kind, id) => `${kind}-${id}`, launchRun: vi.fn(),
      continueRun: vi.fn(), now: () => 10 });
    const lifecycle = createWorkItemRuntimeLifecycle({ db, bus, service });
    const draft = await service.create({ requestId: "create-resume", projectId: "p",
      projectPath: "/repo", title: "T", changeMode: "live" });
    await service.startRun({ requestId: "start-resume", workItemId: draft.workItem.id,
      prompt: "go", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const identity = { workItemId: draft.workItem.id, runKey: "run-start-resume",
      runKind: "primary" as const, parentRunKey: null, taskId: null };
    lifecycle.runStarted({ ...identity, at: 11 });
    lifecycle.runWaiting({ ...identity, waitKind: "timer", at: 12 });

    lifecycle.providerInitialized({ ...identity, providerSessionId: "fresh-thread",
      providerGeneration: 2, at: 13 });
    expect(() => lifecycle.runStarted({ ...identity, at: 14 })).not.toThrow();
    expect((await service.get(draft.workItem.id))?.workItem).toMatchObject({
      waitKind: null,
      lifecycle: { runtimeState: "working" },
    });
    expect(db.prepare("SELECT session_id FROM sessions WHERE session_key = ?")
      .get(identity.runKey)).toEqual({ session_id: "fresh-thread" });
  });

  it("normalizes a completion signal without a final report to interrupted", async () => {
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const bus = createBus({ clients: new Set() } as never);
    const service = createSqliteWorkItemService({ db, bus,
      generateKey: (kind, id) => `${kind}-${id}`, launchRun: vi.fn(),
      continueRun: vi.fn(), now: () => 10 });
    const lifecycle = createWorkItemRuntimeLifecycle({ db, bus, service });
    const draft = await service.create({ requestId: "create-missing-report",
      projectId: "p", projectPath: "/repo", title: "T", changeMode: "live" });
    await service.startRun({ requestId: "missing-report",
      workItemId: draft.workItem.id, prompt: "go",
      expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    lifecycle.runTerminal({ workItemId: draft.workItem.id,
      runKey: "run-missing-report", runKind: "primary",
      parentRunKey: null, taskId: null, outcome: "completed",
      finalReportId: null, finalReport: null, at: 11 });
    expect((await service.get(draft.workItem.id))?.currentRun).toMatchObject({
      outcome: "interrupted", finalReport: null,
    });
  });
});
