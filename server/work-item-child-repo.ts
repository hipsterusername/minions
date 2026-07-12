import type Database from "better-sqlite3";
import type { Outcome } from "../shared/work-item-lifecycle.ts";
import { persistRunReport } from "./work-item-report-repo.ts";
import {
  WorkItemConflictError,
  getWorkItem,
  getWorkItemRun,
  type WorkItemRunRow,
} from "./work-item-repo.ts";

export function createChildWorkItemRun(db: Database.Database, input: {
  workItemId: string; runKey: string; parentRunKey: string; taskId: string;
  idempotencyKey: string; at: number;
}): { run: WorkItemRunRow; idempotent: boolean } {
  if (!input.idempotencyKey) throw new Error("idempotencyKey is required");
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
      started_at, ended_at, run_outcome, final_report_event_id,
      start_idempotency_key, created_at, updated_at
    ) VALUES (?, ?, 'idle', ?, 'minion', ?, ?, NULL, 'child', NULL, ?, ?, ?, NULL,
      'none', NULL, ?, ?, ?)`)
      .run(input.runKey, item.project_id, item.project_path, item.title, item.id,
        input.parentRunKey, input.taskId, input.at, input.idempotencyKey, iso, iso);
    return { run: getWorkItemRun(db, input.runKey)!, idempotent: false };
  }).immediate();
}

export function sealChildWorkItemRun(db: Database.Database, input: {
  workItemId: string; runKey: string; outcome: Exclude<Outcome, "none">;
  finalReportEventId?: string | null; finalReport?: string | null; at: number;
}): { run: WorkItemRunRow; idempotent: boolean } {
  if (input.outcome === "completed"
    && (!input.finalReportEventId?.trim() || !input.finalReport?.trim())) {
    throw new Error("completed child runs require a durable final report event and content");
  }
  return db.transaction(() => {
    if (input.outcome === "completed") persistRunReport(db, { id: input.finalReportEventId!,
      workItemId: input.workItemId, runKey: input.runKey, text: input.finalReport!, at: input.at });
    const run = getWorkItemRun(db, input.runKey);
    if (!run || run.work_item_id !== input.workItemId || run.run_kind !== "child") {
      throw new WorkItemConflictError("child run does not belong to work item", getWorkItem(db, input.workItemId));
    }
    const effective = input.outcome === "completed" && !input.finalReportEventId ? "interrupted" : input.outcome;
    if (run.ended_at !== null) {
      if (run.run_outcome !== effective || run.final_report_event_id !== (input.finalReportEventId ?? null)
        || run.final_report !== (input.finalReport ?? null)) {
        throw new Error("terminal child run outcome and report are immutable");
      }
      return { run, idempotent: true };
    }
    const changed = db.prepare(`UPDATE sessions SET ended_at = ?, run_outcome = ?,
      final_report_event_id = ?, final_report = ?, updated_at = ?
      WHERE session_key = ? AND ended_at IS NULL AND run_kind = 'child'`)
      .run(input.at, effective, input.finalReportEventId ?? null, input.finalReport ?? null,
        new Date(input.at).toISOString(), input.runKey);
    if (changed.changes !== 1) throw new Error("child run was concurrently sealed");
    return { run: getWorkItemRun(db, input.runKey)!, idempotent: false };
  }).immediate();
}
