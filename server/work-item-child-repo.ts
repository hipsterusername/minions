import type Database from "better-sqlite3";
import type { Outcome } from "../shared/work-item-lifecycle.ts";
import {
  mergeSealedRunReport,
  persistOptionalRunReport,
} from "./work-item-terminal-report.ts";
import {
  WorkItemConflictError,
  getWorkItem,
  getWorkItemRun,
  type WorkItemRunRow,
} from "./work-item-repo.ts";

export function createChildWorkItemRun(db: Database.Database, input: {
  workItemId: string; runKey: string; parentRunKey: string; taskId: string;
  attemptId?: string; attemptNumber?: number;
  idempotencyKey: string; at: number;
}): { run: WorkItemRunRow; idempotent: boolean } {
  if (!input.idempotencyKey) throw new Error("idempotencyKey is required");
  const attemptId = input.attemptId ?? input.runKey;
  const attemptNumber = input.attemptNumber ?? 1;
  if (!attemptId || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("valid child attempt identity is required");
  }
  return db.transaction(() => {
    const duplicate = db.prepare(`SELECT session_key FROM sessions
      WHERE work_item_id = ? AND start_idempotency_key = ?`)
      .get(input.workItemId, input.idempotencyKey) as { session_key: string } | undefined;
    if (duplicate) return { run: getWorkItemRun(db, duplicate.session_key)!, idempotent: true };
    const parent = getWorkItemRun(db, input.parentRunKey);
    const item = getWorkItem(db, input.workItemId);
    if (!item || !parent || parent.work_item_id !== item.id || parent.run_kind !== "primary"
      || parent.ended_at !== null || item.current_run_key !== parent.session_key) {
      throw new WorkItemConflictError("invalid child-run parent", item);
    }
    const iso = new Date(input.at).toISOString();
    db.prepare(`INSERT INTO sessions (
      session_key, project_id, status, cwd, role, task_name, work_item_id,
      run_number, run_kind, previous_run_key, parent_run_key, task_id,
      attempt_id, attempt_number,
      started_at, ended_at, run_outcome, final_report_event_id,
      start_idempotency_key, created_at, updated_at
    ) VALUES (?, ?, 'idle', ?, 'minion', ?, ?, NULL, 'child', NULL, ?, ?, ?, ?, ?, NULL,
      'none', NULL, ?, ?, ?)`)
      .run(input.runKey, item.project_id, item.project_path, item.title, item.id,
        input.parentRunKey, input.taskId, attemptId, attemptNumber,
        input.at, input.idempotencyKey, iso, iso);
    return { run: getWorkItemRun(db, input.runKey)!, idempotent: false };
  }).immediate();
}

export function sealChildWorkItemRun(db: Database.Database, input: {
  workItemId: string; runKey: string; outcome: Exclude<Outcome, "none">;
  finalReportEventId?: string | null; finalReport?: string | null; at: number;
}): { run: WorkItemRunRow; idempotent: boolean } {
  return db.transaction(() => {
    const run = getWorkItemRun(db, input.runKey);
    if (!run || run.work_item_id !== input.workItemId || run.run_kind !== "child") {
      throw new WorkItemConflictError("child run does not belong to work item", getWorkItem(db, input.workItemId));
    }
    if (run.ended_at !== null) {
      const merge = mergeSealedRunReport(db, { existingRun: run, ...input });
      if (merge.changed) {
        return { run: getWorkItemRun(db, input.runKey)!, idempotent: false };
      }
      return { run, idempotent: true };
    }
    persistOptionalRunReport(db, input);
    const changed = db.prepare(`UPDATE sessions SET ended_at = ?, run_outcome = ?,
      final_report_event_id = ?, final_report = ?, updated_at = ?
      WHERE session_key = ? AND ended_at IS NULL AND run_kind = 'child'`)
      .run(input.at, input.outcome, input.finalReportEventId ?? null, input.finalReport ?? null,
        new Date(input.at).toISOString(), input.runKey);
    if (changed.changes !== 1) throw new Error("child run was concurrently sealed");
    return { run: getWorkItemRun(db, input.runKey)!, idempotent: false };
  }).immediate();
}
