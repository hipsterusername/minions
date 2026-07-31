import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { backfillLegacyWorkItems, legacyWorkItemId } from "./work-item-migration.ts";
import { repairCompletedRunsWithoutReports } from "./work-item-report-repair.ts";

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

describe("repairCompletedRunsWithoutReports", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
    ensureWorkItemSchema(db);
  });

  it("preserves a completed run when no report was produced", () => {
    insertLegacy(db, {
      key: "broken-complete", status: "idle",
      reviewState: "completion_to_review", finalReport: "Was present",
      terminalReason: "completed", terminalAt: 50,
    });
    backfillLegacyWorkItems(db, 100);
    db.prepare("UPDATE sessions SET final_report = NULL WHERE session_key = ?")
      .run("broken-complete");

    expect(repairCompletedRunsWithoutReports(db, 200)).toEqual([]);
    expect(db.prepare(`SELECT run_outcome, final_report, review_state
      FROM sessions WHERE session_key = ?`).get("broken-complete")).toEqual({
      run_outcome: "completed", final_report: null,
      review_state: "completion_to_review",
    });
    expect(db.prepare(`SELECT runtime_state, outcome FROM work_items
      WHERE id = ?`).get(legacyWorkItemId("broken-complete"))).toEqual({
      runtime_state: "inactive", outcome: "completed",
    });
    expect(repairCompletedRunsWithoutReports(db, 300)).toEqual([]);
  });

  it("restores completed snapshot content from an existing durable report", () => {
    insertLegacy(db, {
      key: "recoverable-complete", status: "idle",
      reviewState: "completion_to_review", finalReport: "Durable result",
      terminalReason: "completed", terminalAt: 50,
    });
    backfillLegacyWorkItems(db, 100);
    const workItemId = legacyWorkItemId("recoverable-complete");
    db.prepare(`INSERT INTO work_item_run_reports
      (id, work_item_id, run_key, report_text, created_at)
      VALUES ('report-1', ?, 'recoverable-complete', 'Durable result', 100)`)
      .run(workItemId);
    db.prepare(`UPDATE sessions SET final_report = NULL, final_report_event_id = NULL
      WHERE session_key = 'recoverable-complete'`).run();

    expect(repairCompletedRunsWithoutReports(db, 200))
      .toEqual(["recoverable-complete"]);
    expect(db.prepare(`SELECT run_outcome, final_report_event_id, final_report
      FROM sessions WHERE session_key = 'recoverable-complete'`).get()).toEqual({
      run_outcome: "completed", final_report_event_id: "report-1",
      final_report: "Durable result",
    });
    expect(db.prepare("SELECT outcome FROM work_items WHERE id = ?")
      .get(workItemId)).toEqual({ outcome: "completed" });
  });

  it("upgrades the former downgrade when clean terminal evidence is already persisted", () => {
    insertLegacy(db, {
      key: "clean-no-report", status: "idle",
      reviewState: "completion_to_review", finalReport: "Initially present",
      terminalReason: "completed", terminalAt: 50,
    });
    backfillLegacyWorkItems(db, 100);
    const workItemId = legacyWorkItemId("clean-no-report");
    db.prepare(`UPDATE sessions SET run_outcome = 'interrupted',
      review_state = 'interrupted_to_review',
      review_reason = 'Session became inactive without a final report',
      final_report = NULL, final_report_event_id = NULL
      WHERE session_key = 'clean-no-report'`).run();
    db.prepare(`UPDATE work_items SET outcome = 'interrupted'
      WHERE id = ?`).run(workItemId);

    expect(repairCompletedRunsWithoutReports(db, 200)).toEqual(["clean-no-report"]);
    expect(db.prepare(`SELECT run_outcome, final_report, review_state, review_reason
      FROM sessions WHERE session_key = 'clean-no-report'`).get()).toEqual({
      run_outcome: "completed",
      final_report: null,
      review_state: "completion_to_review",
      review_reason: "Review the completed session",
    });
    expect(db.prepare("SELECT outcome FROM work_items WHERE id = ?")
      .get(workItemId)).toEqual({ outcome: "completed" });
  });

  it("upgrades a former missing-report interruption when its report becomes durable", () => {
    insertLegacy(db, {
      key: "late-report", status: "idle",
      reviewState: "completion_to_review", finalReport: "Initially present",
      terminalReason: "completed", terminalAt: 50,
    });
    backfillLegacyWorkItems(db, 100);
    const workItemId = legacyWorkItemId("late-report");
    db.prepare(`UPDATE sessions SET run_outcome = 'interrupted',
      review_state = 'interrupted_to_review',
      review_reason = 'Session became inactive without a final report',
      final_report = NULL, final_report_event_id = NULL
      WHERE session_key = 'late-report'`).run();
    db.prepare(`UPDATE work_items SET outcome = 'interrupted'
      WHERE id = ?`).run(workItemId);
    db.prepare(`INSERT INTO work_item_run_reports
      (id, work_item_id, run_key, report_text, created_at)
      VALUES ('late-report-event', ?, 'late-report', 'Durable later report', 150)`)
      .run(workItemId);

    expect(repairCompletedRunsWithoutReports(db, 200)).toEqual(["late-report"]);
    expect(db.prepare(`SELECT run_outcome, final_report, review_state, terminal_reason
      FROM sessions WHERE session_key = 'late-report'`).get()).toEqual({
      run_outcome: "completed",
      final_report: "Durable later report",
      review_state: "completion_to_review",
      terminal_reason: "completed",
    });
    expect(db.prepare("SELECT outcome FROM work_items WHERE id = ?")
      .get(workItemId)).toEqual({ outcome: "completed" });
  });
});
