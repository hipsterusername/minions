import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import type { WorkItemRunRow } from "./work-item-repo.ts";
import { mergeSealedRunReport } from "./work-item-terminal-report.ts";

describe("terminal report merge", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    ensureWorkItemSchema(db);
    db.prepare(`INSERT INTO work_items (
      id, project_id, project_path, title, runtime_state, outcome, resolution,
      change_mode, integration_state, current_run_key,
      lifecycle_revision, last_transition_at, created_at, updated_at
    ) VALUES (
      'work-1', 'project-1', '/repo', 'Task', 'inactive', 'interrupted', 'open',
      'live', 'live_clean', 'run-1', 2, 20, 10, 20
    )`).run();
    db.prepare(`INSERT INTO sessions (
      session_key, status, cwd, role, created_at, updated_at,
      work_item_id, run_number, run_kind, started_at, ended_at, run_outcome,
      start_idempotency_key, terminal_reason, terminal_at
    ) VALUES (
      'run-1', 'stopped', '/repo', 'leader', 'old', 'old',
      'work-1', 1, 'primary', 10, 20, 'interrupted',
      'start', 'completed', 20
    )`).run();
  });

  it("adds a durable report and CAS-upgrades the old interrupted outcome", () => {
    const existingRun = db.prepare("SELECT * FROM sessions WHERE session_key = 'run-1'")
      .get() as WorkItemRunRow;
    const result = mergeSealedRunReport(db, {
      existingRun,
      workItemId: "work-1",
      runKey: "run-1",
      outcome: "completed",
      finalReportEventId: "report-1",
      finalReport: "Completed work",
      expectedLifecycleRevision: 2,
      expectedCurrentRunKey: "run-1",
      at: 30,
    });

    expect(result).toEqual({ changed: true, casConflict: false });
    expect(db.prepare(`SELECT run_outcome, final_report, review_state, terminal_reason
      FROM sessions WHERE session_key = 'run-1'`).get()).toEqual({
      run_outcome: "completed",
      final_report: "Completed work",
      review_state: "completion_to_review",
      terminal_reason: "completed",
    });
    expect(db.prepare("SELECT outcome, lifecycle_revision FROM work_items WHERE id = 'work-1'")
      .get()).toEqual({ outcome: "completed", lifecycle_revision: 3 });
  });

  it("rejects a stale primary upgrade without partially adding its report", () => {
    const existingRun = db.prepare("SELECT * FROM sessions WHERE session_key = 'run-1'")
      .get() as WorkItemRunRow;
    expect(mergeSealedRunReport(db, {
      existingRun,
      workItemId: "work-1",
      runKey: "run-1",
      outcome: "completed",
      finalReportEventId: "stale-report",
      finalReport: "Stale completion",
      expectedLifecycleRevision: 1,
      expectedCurrentRunKey: "run-1",
      at: 30,
    })).toEqual({ changed: false, casConflict: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_item_run_reports").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT run_outcome, final_report FROM sessions WHERE session_key = 'run-1'")
      .get()).toEqual({ run_outcome: "interrupted", final_report: null });
    expect(db.prepare("SELECT outcome, lifecycle_revision FROM work_items WHERE id = 'work-1'")
      .get()).toEqual({ outcome: "interrupted", lifecycle_revision: 2 });
  });
});
