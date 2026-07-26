import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createChildWorkItemRun } from "./work-item-child-repo.ts";
import {
  backfillLegacyWorkItems,
  legacyProjectIdentity,
  legacyWorkItemId,
  recoverOrphanedWorkItemRuns,
} from "./work-item-migration.ts";
import { repairInvalidCompletedWorkItemRuns } from "./work-item-run-repair.ts";

function insertLegacy(db: Database.Database, input: {
  key: string;
  status?: string;
  role?: string;
  projectId?: string | null;
  cwd?: string;
  taskName?: string | null;
  reviewState?: string;
  finalReport?: string | null;
  terminalReason?: string | null;
  terminalAt?: number | null;
  acknowledgedAt?: number | null;
  dismissedAt?: number | null;
  lifecycleRevision?: number;
  dashboardRevision?: number;
  finalDashboardRevision?: number | null;
}): void {
  db.prepare(`
    INSERT INTO sessions (
      session_key, project_id, status, cwd, role, task_name,
      review_state, final_report, terminal_reason, terminal_at,
      acknowledged_at, dismissed_at, lifecycle_revision,
      dashboard_revision, final_dashboard_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.key, input.projectId ?? null, input.status ?? "idle", input.cwd ?? "/repo",
    input.role ?? "leader", input.taskName ?? "Legacy task",
    input.reviewState ?? "none", input.finalReport ?? null,
    input.terminalReason ?? null, input.terminalAt ?? null,
    input.acknowledgedAt ?? null, input.dismissedAt ?? null,
    input.lifecycleRevision ?? 0, input.dashboardRevision ?? 0,
    input.finalDashboardRevision ?? null,
    "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z",
  );
}

describe("legacy session work-item backfill", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
    ensureWorkItemSchema(db);
  });

  it("deterministically backfills leader/default sessions and excludes child roles", () => {
    insertLegacy(db, { key: "leader-1", projectId: "project-1" });
    insertLegacy(db, { key: "default-1", role: "default", cwd: "/same/repo" });
    insertLegacy(db, { key: "minion-1", role: "minion" });

    const first = backfillLegacyWorkItems(db, 1_800_000_000_000);
    expect(first.workItemIds).toEqual([
      legacyWorkItemId("default-1"),
      legacyWorkItemId("leader-1"),
    ]);
    expect(backfillLegacyWorkItems(db, 1_900_000_000_000).workItemIds).toEqual([]);
    expect(db.prepare("SELECT work_item_id FROM sessions WHERE session_key = 'minion-1'").get())
      .toEqual({ work_item_id: null });

    const fallback = legacyProjectIdentity(null, "/same/repo", null);
    expect(db.prepare("SELECT project_id FROM work_items WHERE id = ?").get(legacyWorkItemId("default-1")))
      .toEqual({ project_id: fallback.projectId });
  });

  it("repairs an exact deterministic partial state and rejects an ownership collision", () => {
    insertLegacy(db, { key: "partial-1", projectId: "project-1" });
    const itemId = legacyWorkItemId("partial-1");
    backfillLegacyWorkItems(db, 100);
    db.prepare("UPDATE sessions SET work_item_id = NULL, run_number = NULL WHERE session_key = ?")
      .run("partial-1");
    expect(backfillLegacyWorkItems(db, 101).workItemIds).toEqual([itemId]);
    expect(db.prepare("SELECT work_item_id, run_number FROM sessions WHERE session_key = ?").get("partial-1"))
      .toEqual({ work_item_id: itemId, run_number: 1 });

    db.prepare("UPDATE sessions SET work_item_id = NULL WHERE session_key = ?").run("partial-1");
    db.prepare("UPDATE work_items SET current_run_key = ? WHERE id = ?").run("other-run", itemId);
    expect(() => backfillLegacyWorkItems(db, 102)).toThrow(/legacy work-item id collision/);
    expect(db.prepare("SELECT work_item_id FROM sessions WHERE session_key = ?").get("partial-1"))
      .toEqual({ work_item_id: null });
  });

  it("preserves reliable completion, review, report, and dashboard history", () => {
    insertLegacy(db, {
      key: "complete-1", status: "idle", reviewState: "completion_to_review",
      finalReport: "Everything shipped", terminalReason: "completed", terminalAt: 50,
      acknowledgedAt: 60, lifecycleRevision: 7, dashboardRevision: 4,
      finalDashboardRevision: 4,
    });
    backfillLegacyWorkItems(db, 100);

    expect(db.prepare(`
      SELECT runtime_state, outcome, resolution, current_run_key, iteration,
             lifecycle_revision FROM work_items WHERE id = ?
    `).get(legacyWorkItemId("complete-1"))).toEqual({
      runtime_state: "inactive", outcome: "completed", resolution: "reviewed",
      current_run_key: "complete-1", iteration: 1, lifecycle_revision: 7,
    });
    expect(db.prepare(`
      SELECT run_number, ended_at, run_outcome, final_report,
             dashboard_revision, final_dashboard_revision
      FROM sessions WHERE session_key = 'complete-1'
    `).get()).toEqual({
      run_number: 1, ended_at: 50, run_outcome: "completed",
      final_report: "Everything shipped", dashboard_revision: 4,
      final_dashboard_revision: 4,
    });
  });

  it.each([
    ["idle-no-report", "idle", null, "abort"],
    ["stopped-no-report", "stopped", "stop", "stop"],
    ["completed-no-report", "completed", "completed", "abort"],
  ])("classifies ambiguous legacy row %s as interrupted", (key, status, terminalReason, normalizedReason) => {
    insertLegacy(db, { key, status, terminalReason });
    backfillLegacyWorkItems(db, 100);
    expect(db.prepare("SELECT outcome, lifecycle_revision FROM work_items WHERE id = ?").get(legacyWorkItemId(key)))
      .toEqual({ outcome: "interrupted", lifecycle_revision: 1 });
    expect(db.prepare(`
      SELECT run_outcome, ended_at, review_state, review_reason, terminal_reason,
             terminal_at, lifecycle_revision FROM sessions WHERE session_key = ?
    `).get(key)).toMatchObject({
      run_outcome: "interrupted", review_state: "interrupted_to_review",
      review_reason: "Session became inactive without a final report",
      terminal_reason: normalizedReason, lifecycle_revision: 1,
    });
  });

  it("normalizes legacy error evidence with no review snapshot", () => {
    insertLegacy(db, { key: "error-none", status: "error", lifecycleRevision: 2 });
    backfillLegacyWorkItems(db, 100);
    expect(db.prepare(`
      SELECT review_state, review_reason, terminal_reason, lifecycle_revision
      FROM sessions WHERE session_key = 'error-none'
    `).get()).toEqual({
      review_state: "error_to_review", review_reason: "Session ended with an error",
      terminal_reason: "error", lifecycle_revision: 3,
    });
    expect(db.prepare("SELECT outcome, lifecycle_revision FROM work_items WHERE id = ?")
      .get(legacyWorkItemId("error-none"))).toEqual({ outcome: "error", lifecycle_revision: 3 });
  });

  it.each([
    ["stale-error", "error", null, null, "error_to_review", "error"],
    ["stale-stop", "stopped", "stop", null, "interrupted_to_review", "interrupted"],
    ["stale-complete", "running", "completed", "Done", "completion_to_review", "completed"],
  ])("repairs stale decision snapshot %s from terminal evidence", (
    key, status, terminalReason, finalReport, reviewState, outcome,
  ) => {
    insertLegacy(db, {
      key, status, reviewState: "decision_needed", terminalReason, finalReport,
      terminalAt: 90, lifecycleRevision: 5,
    });
    backfillLegacyWorkItems(db, 100);
    expect(db.prepare(`
      SELECT review_state, terminal_reason, lifecycle_revision
      FROM sessions WHERE session_key = ?
    `).get(key)).toMatchObject({
      review_state: reviewState, terminal_reason: terminalReason === "completed" ? "completed" : terminalReason ?? "error",
      lifecycle_revision: 6,
    });
    expect(db.prepare("SELECT outcome, lifecycle_revision FROM work_items WHERE id = ?")
      .get(legacyWorkItemId(key))).toEqual({ outcome, lifecycle_revision: 6 });
  });

  it("retains a structured decision wait for boot recovery instead of parsing prose", () => {
    insertLegacy(db, {
      key: "waiting-1", status: "waiting", reviewState: "decision_needed",
    });
    backfillLegacyWorkItems(db, 100);
    expect(db.prepare(`
      SELECT runtime_state, outcome, wait_kind FROM work_items WHERE id = ?
    `).get(legacyWorkItemId("waiting-1"))).toEqual({
      runtime_state: "waiting", outcome: "none", wait_kind: "decision",
    });
    expect(db.prepare("SELECT ended_at FROM sessions WHERE session_key = 'waiting-1'").get())
      .toEqual({ ended_at: null });
  });
});

describe("boot recovery", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
    ensureWorkItemSchema(db);
  });

  it("seals orphaned active primary runs exactly once while preserving terminal rows", () => {
    insertLegacy(db, { key: "orphan", status: "running", lifecycleRevision: 3 });
    insertLegacy(db, {
      key: "terminal", status: "idle", reviewState: "completion_to_review",
      finalReport: "Done", terminalReason: "completed", terminalAt: 25,
      lifecycleRevision: 4,
    });
    backfillLegacyWorkItems(db, 100);

    expect(recoverOrphanedWorkItemRuns(db, new Set(), 200).recoveredRunKeys)
      .toEqual(["orphan"]);
    expect(recoverOrphanedWorkItemRuns(db, new Set(), 300).recoveredRunKeys).toEqual([]);
    expect(db.prepare(`
      SELECT runtime_state, outcome, resolution, lifecycle_revision, updated_at
      FROM work_items WHERE id = ?
    `).get(legacyWorkItemId("orphan"))).toEqual({
      runtime_state: "inactive", outcome: "interrupted", resolution: "open",
      lifecycle_revision: 4, updated_at: 200,
    });
    expect(db.prepare(`
      SELECT ended_at, run_outcome, status, review_state, terminal_reason,
             terminal_at, lifecycle_revision
      FROM sessions WHERE session_key = 'orphan'
    `).get()).toEqual({
      ended_at: 200, run_outcome: "interrupted", status: "stopped",
      review_state: "interrupted_to_review", terminal_reason: "abort",
      terminal_at: 200, lifecycle_revision: 4,
    });
    expect(db.prepare(`
      SELECT outcome, lifecycle_revision, updated_at FROM work_items WHERE id = ?
    `).get(legacyWorkItemId("terminal"))).toEqual({
      outcome: "completed", lifecycle_revision: 4,
      updated_at: Date.parse("2026-01-02T00:00:00.000Z"),
    });
  });

  it("does not recover a run reported live by the runtime registry", () => {
    insertLegacy(db, { key: "live-1", status: "running" });
    backfillLegacyWorkItems(db, 100);
    expect(recoverOrphanedWorkItemRuns(db, new Set(["live-1"]), 200).recoveredRunKeys)
      .toEqual([]);
    expect(db.prepare("SELECT ended_at, run_outcome FROM sessions WHERE session_key = 'live-1'").get())
      .toEqual({ ended_at: null, run_outcome: "none" });
  });

  it("repairs completed rows without finalReport before snapshot validation", () => {
    for (const id of ["restore", "downgrade"]) {
      insertLegacy(db, { key: id, status: "running" });
    }
    backfillLegacyWorkItems(db, 100);
    for (const id of ["restore", "downgrade"]) {
      db.prepare(`UPDATE sessions SET ended_at = 120, run_outcome = 'completed',
        final_report = NULL, final_report_event_id = NULL WHERE session_key = ?`).run(id);
      db.prepare(`UPDATE work_items SET runtime_state = 'inactive',
        outcome = 'completed' WHERE id = ?`).run(legacyWorkItemId(id));
    }
    db.prepare(`INSERT INTO work_item_run_reports
      (id, work_item_id, run_key, report_text, created_at)
      VALUES ('report-restore', ?, 'restore', 'Durable result', 119)`)
      .run(legacyWorkItemId("restore"));

    expect(repairInvalidCompletedWorkItemRuns(db, 130)).toEqual({
      restoredRunKeys: ["restore"],
      interruptedRunKeys: ["downgrade"],
    });
    expect(db.prepare(`SELECT run_outcome, final_report FROM sessions
      WHERE session_key = 'restore'`).get()).toEqual({
      run_outcome: "completed", final_report: "Durable result",
    });
    expect(db.prepare(`SELECT run_outcome, final_report FROM sessions
      WHERE session_key = 'downgrade'`).get()).toEqual({
      run_outcome: "interrupted", final_report: null,
    });
    expect(db.prepare(`SELECT outcome FROM work_items WHERE id = ?`)
      .get(legacyWorkItemId("downgrade"))).toEqual({ outcome: "interrupted" });
  });

  it("recovers orphaned children and tasks without changing the item projection", () => {
    insertLegacy(db, { key: "parent", status: "running", lifecycleRevision: 2 });
    backfillLegacyWorkItems(db, 100);
    const workItemId = legacyWorkItemId("parent");
    createChildWorkItemRun(db, {
      workItemId, runKey: "child-orphan", parentRunKey: "parent", taskId: "task-1",
      idempotencyKey: "child-1", at: 110,
    });
    createChildWorkItemRun(db, {
      workItemId, runKey: "child-live", parentRunKey: "parent", taskId: "task-2",
      idempotencyKey: "child-2", at: 120,
    });
    db.prepare(`
      INSERT INTO task_records (
        task_id, leader_session_key, title, executor, minion_session_key,
        status, created_at
      ) VALUES (?, 'parent', ?, 'minion', ?, ?, 100)
    `).run("task-1", "orphan task", "child-orphan", "running");
    db.prepare(`
      INSERT INTO task_records (
        task_id, leader_session_key, title, executor, minion_session_key,
        status, created_at
      ) VALUES (?, 'parent', ?, 'minion', ?, ?, 100)
    `).run("task-2", "live task", "child-live", "blocked");

    const before = db.prepare(`
      SELECT lifecycle_revision FROM work_items WHERE id = ?
    `).get(workItemId) as { lifecycle_revision: number };
    expect(recoverOrphanedWorkItemRuns(db, new Set(["parent", "child-live"]), 200).recoveredRunKeys)
      .toEqual(["child-orphan"]);
    expect(db.prepare(`SELECT ended_at, run_outcome FROM sessions WHERE session_key = 'child-orphan'`).get())
      .toEqual({ ended_at: 200, run_outcome: "interrupted" });
    expect(db.prepare(`SELECT ended_at, run_outcome FROM sessions WHERE session_key = 'child-live'`).get())
      .toEqual({ ended_at: null, run_outcome: "none" });
    expect(db.prepare(`SELECT status, completed_at FROM task_records WHERE task_id = 'task-1'`).get())
      .toEqual({ status: "orphaned", completed_at: 200 });
    expect(db.prepare(`SELECT status, completed_at FROM task_records WHERE task_id = 'task-2'`).get())
      .toEqual({ status: "blocked", completed_at: null });
    expect((db.prepare(`SELECT lifecycle_revision FROM work_items WHERE id = ?`).get(workItemId) as { lifecycle_revision: number }).lifecycle_revision)
      .toBe(before.lifecycle_revision);
    expect(recoverOrphanedWorkItemRuns(db, new Set(["parent", "child-live"]), 300).recoveredRunKeys)
      .toEqual([]);
  });
});
