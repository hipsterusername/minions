import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createBus } from "./bus.ts";
import { createSqliteWorkItemService } from "./work-item-service-sqlite.ts";
import { createLiveEditCoordinator, LiveEditBaselineConflictError } from "./live-edit-coordinator.ts";
import { applyLiveEditWorkItemProjection, createLiveEditWorkItemBridge } from "./live-edit-work-item-bridge.ts";
import { createChildWorkItemRun } from "./work-item-child-repo.ts";
import { installLiveEditWorkItemBridges } from "./live-edit-work-item-runtime.ts";
import { getLiveEditCoordinator, resetLiveEditCoordinators } from "./live-edit-runtime.ts";
import { liveEditCoordinationEnvelopeSchema, liveEditCoordinationEventSchema } from "../shared/live-edit-coordination.ts";

const roots: string[] = [];
afterEach(() => { resetLiveEditCoordinators();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("live-edit work-item bridge", () => {
  it("parses every core event and wakes FIFO grants without a provider continuation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minions-live-bridge-")); roots.push(root);
    fs.writeFileSync(path.join(root, "shared.ts"), "before");
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const bus = createBus({ clients: new Set() } as never); const continueRun = vi.fn();
    const delivery: Array<{ type: string; runtime?: string }> = [];
    let key = 0; let now = 10;
    const service = createSqliteWorkItemService({ db, bus,
      generateKey: (kind) => `${kind}-${++key}`, launchRun: vi.fn(), continueRun,
      now: () => now++ });
    const first = await service.create({ requestId: "create-1", projectId: "project",
      projectPath: root, title: "First", changeMode: "live" });
    const second = await service.create({ requestId: "create-2", projectId: "project",
      projectPath: root, title: "Second", changeMode: "live" });
    bus.subscribe((event) => { if (event.type === "live_edit_coordination")
      expect(liveEditCoordinationEnvelopeSchema.safeParse(event).success).toBe(true);
      if (event.type === "live_edit_coordination"
      || (event.type === "work_item_changed" && String(event["cause"]).startsWith("live_edit_")))
      delivery.push({ type: event.type, runtime: service.getSync(second.workItem.id)
        ?.workItem.lifecycle.runtimeState }); });
    const run1 = await service.startRun({ requestId: "start-1", workItemId: first.workItem.id,
      prompt: "one", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    const run2 = await service.startRun({ requestId: "start-2", workItemId: second.workItem.id,
      prompt: "two", expectedLifecycleRevision: 0, expectedCurrentRunKey: null });
    db.prepare("UPDATE work_items SET runtime_state = 'working' WHERE id IN (?, ?)")
      .run(first.workItem.id, second.workItem.id);
    const coordinator = createLiveEditCoordinator({ projectPath: root, now: () => now++ });
    const coreEvents: unknown[] = []; coordinator.subscribe((event) => coreEvents.push(event));
    const bridge = createLiveEditWorkItemBridge({ coordinator, db, bus, service });
    const lease1 = await coordinator.claim({ requestId: "claim-1", workItemId: first.workItem.id,
      runKey: run1.workItem.currentRunKey!, paths: [{ path: "shared.ts", scope: "file" }] });
    coordinator.heartbeat(lease1.token);
    fs.writeFileSync(path.join(root, "shared.ts"), "changed");
    expect(() => coordinator.revalidate(lease1.token)).toThrow(LiveEditBaselineConflictError);
    const claim2 = coordinator.claim({ requestId: "claim-2", workItemId: second.workItem.id,
      runKey: run2.workItem.currentRunKey!, paths: [{ path: "shared.ts", scope: "file" }] });
    expect(service.getSync(second.workItem.id)?.workItem).toMatchObject({
      waitKind: "file_conflict", lifecycle: { runtimeState: "waiting",
        integrationState: "live_conflict_wait" } });
    const queuedDelivery = delivery.findIndex((entry) => entry.type === "live_edit_coordination"
      && entry.runtime === "waiting");
    expect(queuedDelivery).toBeGreaterThanOrEqual(0);
    expect(delivery.slice(queuedDelivery + 1).findIndex((entry) => entry.type === "work_item_changed"))
      .toBeGreaterThanOrEqual(0);
    coordinator.release(lease1.token, "done"); await claim2;
    expect(service.getSync(second.workItem.id)?.workItem.lifecycle).toMatchObject({
      runtimeState: "working", integrationState: "live_editing" });
    expect(continueRun).not.toHaveBeenCalled();
    for (const event of coreEvents) expect(liveEditCoordinationEventSchema.safeParse(event).success).toBe(true);
    bridge.unsubscribe();
  });

  it("keeps item conflict projection until every run is clear", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minions-live-aggregate-")); roots.push(root);
    const coordinator = createLiveEditCoordinator({ projectPath: root });
    const first = await coordinator.claim({ requestId: "one", workItemId: "work",
      runKey: "run-1", paths: [{ path: "a.ts", scope: "file" }] });
    const second = await coordinator.claim({ requestId: "two", workItemId: "work",
      runKey: "run-2", paths: [{ path: "b.ts", scope: "file" }] });
    fs.writeFileSync(path.join(root, "a.ts"), "changed");
    expect(() => coordinator.revalidate(first.token)).toThrow(LiveEditBaselineConflictError);
    const waiting = coordinator.claim({ requestId: "three", workItemId: "work",
      runKey: "run-3", paths: [{ path: "a.ts", scope: "file" }] });
    expect(coordinator.snapshotWorkItem("work").state).toBe("waiting");
    expect(coordinator.snapshotWorkItem("work").baselineConflict).toBe(true);
    coordinator.release(first.token); const third = await waiting;
    expect(coordinator.snapshotWorkItem("work").state).toBe("editing");
    coordinator.release(second.token);
    expect(coordinator.snapshotWorkItem("work").state).toBe("editing");
    coordinator.release(third.token);
    expect(coordinator.snapshotWorkItem("work").state).toBe("clean");
  });

  it("bridges lazily-created production coordinators and cleans them on shutdown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minions-live-runtime-")); roots.push(root);
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const bus = createBus({ clients: new Set() } as never);
    const service = createSqliteWorkItemService({ db, bus,
      generateKey: (kind) => `${kind}-runtime`, launchRun: vi.fn(), continueRun: vi.fn() });
    const created = await service.create({ requestId: "create-runtime", projectId: "project",
      projectPath: root, title: "Runtime", changeMode: "live" });
    const started = await service.startRun({ requestId: "start-runtime",
      workItemId: created.workItem.id, prompt: "go", expectedLifecycleRevision: 0,
      expectedCurrentRunKey: null });
    db.prepare("UPDATE work_items SET runtime_state = 'working' WHERE id = ?")
      .run(created.workItem.id);
    const installed = installLiveEditWorkItemBridges({ db, bus, service });
    const coordinator = getLiveEditCoordinator(root);
    expect(installed.size).toBe(1);
    await coordinator.claim({ requestId: "claim-runtime", workItemId: created.workItem.id,
      runKey: started.workItem.currentRunKey!, paths: [{ path: "x.ts", scope: "file" }] });
    expect(service.getSync(created.workItem.id)?.workItem.lifecycle.integrationState)
      .toBe("live_editing");
    installed.shutdown();
    expect(service.getSync(created.workItem.id)?.workItem.lifecycle.integrationState)
      .toBe("live_clean");
    expect(installed.size).toBe(0);
  });

  it("uses item aggregate for integration but never pauses a working primary for a child queue", async () => {
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    const service = createSqliteWorkItemService({ db,
      bus: createBus({ clients: new Set() } as never), generateKey: (kind) => `${kind}-aggregate`,
      launchRun: vi.fn(), continueRun: vi.fn(), now: () => 10 });
    const created = await service.create({ requestId: "create-aggregate", projectId: "project",
      projectPath: "/repo", title: "Aggregate", changeMode: "live" });
    const started = await service.startRun({ requestId: "start-aggregate",
      workItemId: created.workItem.id, prompt: "go", expectedLifecycleRevision: 0,
      expectedCurrentRunKey: null });
    const primary = started.workItem.currentRunKey!;
    db.prepare("UPDATE work_items SET runtime_state = 'working' WHERE id = ?")
      .run(created.workItem.id);
    createChildWorkItemRun(db, { workItemId: created.workItem.id, runKey: "child",
      parentRunKey: primary, taskId: "task", idempotencyKey: "child", at: 11 });
    applyLiveEditWorkItemProjection(db, { type: "queued", requestId: "queue",
      workItemId: created.workItem.id, runKey: "child", runState: "waiting",
      workItemState: "waiting", paths: ["a.ts"], queuePosition: 1,
      blockingRunKeys: [primary], at: 12 });
    expect(service.getSync(created.workItem.id)?.workItem.lifecycle).toMatchObject({
      runtimeState: "working", integrationState: "live_conflict_wait" });
    applyLiveEditWorkItemProjection(db, { type: "heartbeat", token: "primary-token",
      workItemId: created.workItem.id, runKey: primary, runState: "editing",
      workItemState: "waiting", paths: ["b.ts"], expiresAt: 30, at: 12 });
    expect(service.getSync(created.workItem.id)?.workItem.lifecycle).toMatchObject({
      runtimeState: "working", integrationState: "live_conflict_wait" });
    applyLiveEditWorkItemProjection(db, { type: "released", token: "child-token",
      workItemId: created.workItem.id, runKey: "child", runState: "clean",
      workItemState: "editing", paths: ["a.ts"], at: 13 });
    expect(service.getSync(created.workItem.id)?.workItem.lifecycle).toMatchObject({
      runtimeState: "working", integrationState: "live_editing" });
  });
});
