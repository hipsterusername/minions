import type Database from "better-sqlite3";

export interface CompletedRunRepairResult {
  restoredRunKeys: string[];
  interruptedRunKeys: string[];
}

/** Repair old completed rows that violate the public final-report invariant. */
export function repairInvalidCompletedWorkItemRuns(
  db: Database.Database,
  at: number = Date.now(),
): CompletedRunRepairResult {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT session_key, work_item_id, run_kind FROM sessions
      WHERE work_item_id IS NOT NULL AND run_outcome = 'completed'
        AND (final_report IS NULL OR trim(final_report) = '') ORDER BY session_key`).all() as
      Array<{ session_key: string; work_item_id: string; run_kind: "primary" | "child" }>;
    const restoredRunKeys: string[] = [];
    const interruptedRunKeys: string[] = [];
    const iso = new Date(at).toISOString();
    for (const row of rows) {
      const report = db.prepare(`SELECT id, report_text FROM work_item_run_reports
        WHERE work_item_id = ? AND run_key = ? AND trim(report_text) <> ''
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(row.work_item_id, row.session_key) as
        { id: string; report_text: string } | undefined;
      if (report) {
        db.prepare(`UPDATE sessions SET final_report_event_id = ?, final_report = ?, updated_at = ?
          WHERE session_key = ? AND run_outcome = 'completed'
            AND (final_report IS NULL OR trim(final_report) = '')`)
          .run(report.id, report.report_text.trim(), iso, row.session_key);
        restoredRunKeys.push(row.session_key);
        continue;
      }
      db.prepare(`UPDATE sessions SET run_outcome = 'interrupted',
        final_report_event_id = NULL, final_report = NULL, status = 'stopped',
        review_state = 'interrupted_to_review',
        review_reason = 'Completed state was missing its durable final report',
        terminal_reason = 'abort', terminal_at = COALESCE(terminal_at, ended_at, ?),
        lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE session_key = ? AND run_outcome = 'completed'
          AND (final_report IS NULL OR trim(final_report) = '')`).run(at, iso, row.session_key);
      if (row.run_kind === "primary") {
        db.prepare(`UPDATE work_items SET runtime_state = 'inactive',
          outcome = 'interrupted', resolution = 'open', wait_kind = NULL,
          lifecycle_revision = lifecycle_revision + 1, last_transition_at = ?, updated_at = ?
          WHERE id = ? AND current_run_key = ? AND outcome = 'completed'`)
          .run(at, at, row.work_item_id, row.session_key);
      }
      interruptedRunKeys.push(row.session_key);
    }
    return { restoredRunKeys, interruptedRunKeys };
  }).immediate();
}

/** Seal one missing active primary so continuation can allocate a new immutable run. */
export function recoverOrphanedWorkItemRun(
  db: Database.Database,
  workItemId: string,
  runKey: string,
  at: number = Date.now(),
): boolean {
  return db.transaction(() => {
    const item = db.prepare(`SELECT lifecycle_revision FROM work_items
      WHERE id = ? AND current_run_key = ? AND runtime_state IN ('starting','working','waiting')
        AND outcome = 'none'`).get(workItemId, runKey) as { lifecycle_revision: number } | undefined;
    if (!item) return false;
    const sealed = db.prepare(`UPDATE sessions SET ended_at = ?, run_outcome = 'interrupted',
      status = 'stopped', review_state = 'interrupted_to_review',
      review_reason = 'Session became inactive without a final report',
      terminal_reason = 'abort', terminal_at = ?, acknowledged_at = NULL,
      dismissed_at = NULL, lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE session_key = ? AND work_item_id = ? AND run_kind = 'primary'
        AND ended_at IS NULL AND run_outcome = 'none'`)
      .run(at, at, new Date(at).toISOString(), runKey, workItemId);
    if (sealed.changes !== 1) return false;
    const changed = db.prepare(`UPDATE work_items SET runtime_state = 'inactive',
      outcome = 'interrupted', resolution = 'open', wait_kind = NULL,
      lifecycle_revision = lifecycle_revision + 1, last_transition_at = ?, updated_at = ?
      WHERE id = ? AND current_run_key = ? AND lifecycle_revision = ?
        AND runtime_state IN ('starting','working','waiting') AND outcome = 'none'`)
      .run(at, at, workItemId, runKey, item.lifecycle_revision);
    if (changed.changes !== 1) throw new Error(`failed to reconcile work item ${workItemId}`);
    return true;
  }).immediate();
}
