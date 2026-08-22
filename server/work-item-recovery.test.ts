import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  closePersistDb,
  disablePersistence,
  openPersistDb,
} from "./session-persist.ts";
import { SessionRegistry } from "./session-registry.ts";
import {
  createWorkItem,
  startWorkItemIteration,
} from "./work-item-repo.ts";
import {
  claimRunInvocationTerminal,
  getRunInvocation,
  recordRunInvocationIntent,
  startRunInvocation,
} from "./work-item-invocations.ts";
import { recoverOrphanedWorkItemRuns } from "./work-item-migration.ts";

function seedRun(db: Database.Database, runKey = "run-1"): void {
  createWorkItem(db, {
    id: "work-1",
    projectId: "project-1",
    projectPath: "/tmp",
    title: "Recovery",
    changeMode: "live",
    at: 10,
  });
  startWorkItemIteration(db, {
    workItemId: "work-1",
    runKey,
    idempotencyKey: `start-${runKey}`,
    expectedLifecycleRevision: 0,
    expectedCurrentRunKey: null,
    at: 20,
  });
  db.prepare("UPDATE sessions SET status = 'running' WHERE session_key = ?")
    .run(runKey);
}

function memoryDb(): Database.Database {
  const db = openPersistDb(":memory:");
  seedRun(db);
  return db;
}

afterEach(() => {
  closePersistDb();
  disablePersistence();
});

describe("work-item boot recovery witnesses", () => {
  it("keeps a clean between-turn run open and hydrates it as resumable", () => {
    const db = memoryDb();
    startRunInvocation(db, {
      runKey: "run-1",
      providerId: "claude",
      startedAt: 30,
    });
    claimRunInvocationTerminal(db, {
      runKey: "run-1",
      providerGeneration: 1,
      terminalKind: "clean",
      terminalSource: "provider",
      terminalAt: 40,
    });

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 50).recoveredRunKeys)
      .toEqual([]);
    expect(db.prepare(`
      SELECT ended_at, run_outcome FROM sessions WHERE session_key = 'run-1'
    `).get()).toEqual({ ended_at: null, run_outcome: "none" });
    expect(db.prepare(`
      SELECT runtime_state, outcome FROM work_items WHERE id = 'work-1'
    `).get()).toEqual({ runtime_state: "starting", outcome: "none" });

    const registry = new SessionRegistry();
    registry.hydrateFromDb();
    expect(registry.get("run-1")).toMatchObject({
      status: "stopped",
      reviewLifecycle: {
        reviewState: "none",
        terminalReason: null,
      },
    });
  });

  it("marks a mid-turn invocation lost at boot and seals it interrupted", () => {
    const db = memoryDb();
    startRunInvocation(db, {
      runKey: "run-1",
      providerId: "codex",
      startedAt: 30,
    });

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 50).recoveredRunKeys)
      .toEqual(["run-1"]);
    expect(getRunInvocation(db, "run-1", 1)).toMatchObject({
      phase: "lost",
      terminal_kind: "lost",
      terminal_source: "boot",
      terminal_at: 50,
    });
    expect(db.prepare(`
      SELECT ended_at, run_outcome, terminal_reason
      FROM sessions WHERE session_key = 'run-1'
    `).get()).toEqual({
      ended_at: 50,
      run_outcome: "interrupted",
      terminal_reason: "abort",
    });
  });

  it("uses durable termination intent when boot finishes a missing seal", () => {
    const db = memoryDb();
    startRunInvocation(db, {
      runKey: "run-1",
      providerId: "claude",
      startedAt: 30,
    });
    recordRunInvocationIntent(db, {
      runKey: "run-1",
      providerGeneration: 1,
      intent: "stop",
    });

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 50).recoveredRunKeys)
      .toEqual(["run-1"]);
    expect(getRunInvocation(db, "run-1", 1)).toMatchObject({
      phase: "terminal",
      terminal_kind: "cancelled",
      terminal_source: "boot",
      termination_intent: "stop",
      terminal_at: 50,
    });
    expect(db.prepare(`
      SELECT ended_at, run_outcome, terminal_reason
      FROM sessions WHERE session_key = 'run-1'
    `).get()).toEqual({
      ended_at: 50,
      run_outcome: "stopped",
      terminal_reason: "stop",
    });
    expect(db.prepare(`
      SELECT runtime_state, outcome FROM work_items WHERE id = 'work-1'
    `).get()).toEqual({
      runtime_state: "inactive",
      outcome: "stopped",
    });
  });

  it("conservatively interrupts a pre-ledger open run", () => {
    const db = memoryDb();

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 50).recoveredRunKeys)
      .toEqual(["run-1"]);
    expect(db.prepare(`
      SELECT ended_at, run_outcome FROM sessions WHERE session_key = 'run-1'
    `).get()).toEqual({ ended_at: 50, run_outcome: "interrupted" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM run_invocations WHERE run_key = 'run-1'
    `).get()).toEqual({ count: 0 });
  });

  it("never seals a waiting leader with a clean terminal witness", () => {
    const db = memoryDb();
    db.prepare(`
      UPDATE work_items SET runtime_state = 'waiting', wait_kind = 'decision'
      WHERE id = 'work-1'
    `).run();
    db.prepare("UPDATE sessions SET status = 'waiting' WHERE session_key = 'run-1'")
      .run();
    startRunInvocation(db, {
      runKey: "run-1",
      providerId: "claude",
      startedAt: 30,
    });
    claimRunInvocationTerminal(db, {
      runKey: "run-1",
      providerGeneration: 1,
      terminalKind: "clean",
      terminalSource: "provider",
      terminalAt: 40,
    });

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 50).recoveredRunKeys)
      .toEqual([]);
    expect(db.prepare(`
      SELECT runtime_state, outcome, wait_kind
      FROM work_items WHERE id = 'work-1'
    `).get()).toEqual({
      runtime_state: "waiting",
      outcome: "none",
      wait_kind: "decision",
    });
    expect(db.prepare(`
      SELECT ended_at, run_outcome FROM sessions WHERE session_key = 'run-1'
    `).get()).toEqual({ ended_at: null, run_outcome: "none" });
  });

  it("repairs inherited decision evidence that was left projected as working", () => {
    const db = memoryDb();
    db.prepare(`UPDATE work_items SET runtime_state = 'working' WHERE id = 'work-1'`).run();
    db.prepare(`UPDATE sessions SET review_state = 'decision_needed',
      review_reason = 'Choose a path' WHERE session_key = 'run-1'`).run();
    startRunInvocation(db, { runKey: "run-1", providerId: "codex", startedAt: 30 });
    claimRunInvocationTerminal(db, { runKey: "run-1", providerGeneration: 1,
      terminalKind: "clean", terminalSource: "provider", terminalAt: 40 });

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 50).recoveredRunKeys).toEqual([]);
    expect(db.prepare(`SELECT runtime_state,outcome,wait_kind,lifecycle_revision
      FROM work_items WHERE id = 'work-1'`).get()).toEqual({
        runtime_state:"waiting",outcome:"none",wait_kind:"decision",lifecycle_revision:2,
      });
    expect(db.prepare(`SELECT ended_at,run_outcome FROM sessions
      WHERE session_key = 'run-1'`).get()).toEqual({ ended_at:null,run_outcome:"none" });

    recoverOrphanedWorkItemRuns(db,new Set(),60);
    expect(db.prepare(`SELECT lifecycle_revision FROM work_items WHERE id = 'work-1'`).get())
      .toEqual({ lifecycle_revision:2 });
  });
});
