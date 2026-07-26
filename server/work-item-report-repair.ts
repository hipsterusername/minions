import type Database from "better-sqlite3";

/**
 * Older builds could persist `completed` before the durable final report was
 * written. Restore content from the durable report table when possible;
 * otherwise completion is not trustworthy, so preserve it as interrupted
 * history instead of letting snapshot validation make the item unreadable.
 */
export function repairCompletedRunsWithoutReports(
  db: Database.Database,
  at: number = Date.now(),
): string[] {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT s.session_key, s.work_item_id, s.run_kind,
        r.id AS report_id, r.report_text
      FROM sessions s
      LEFT JOIN work_item_run_reports r ON r.run_key = s.session_key
      WHERE s.work_item_id IS NOT NULL AND s.run_outcome = 'completed'
        AND TRIM(COALESCE(s.final_report, '')) = ''
      ORDER BY s.session_key
    `).all() as Array<{
      session_key: string;
      work_item_id: string;
      run_kind: "primary" | "child";
      report_id: string | null;
      report_text: string | null;
    }>;
    const repaired: string[] = [];
    for (const row of rows) {
      if (row.report_id && row.report_text?.trim()) {
        const restored = db.prepare(`
          UPDATE sessions SET final_report_event_id = ?, final_report = ?, updated_at = ?
          WHERE session_key = ? AND run_outcome = 'completed'
            AND TRIM(COALESCE(final_report, '')) = ''
        `).run(row.report_id, row.report_text, new Date(at).toISOString(), row.session_key);
        if (restored.changes === 1) repaired.push(row.session_key);
        continue;
      }
      const changed = db.prepare(`
        UPDATE sessions SET run_outcome = 'interrupted',
          final_report_event_id = NULL, final_report = NULL,
          status = 'stopped', review_state = 'interrupted_to_review',
          review_reason = 'Session became inactive without a final report',
          terminal_reason = 'abort', terminal_at = COALESCE(terminal_at, ended_at, ?),
          acknowledged_at = NULL, dismissed_at = NULL,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE session_key = ? AND run_outcome = 'completed'
          AND TRIM(COALESCE(final_report, '')) = ''
      `).run(at, new Date(at).toISOString(), row.session_key);
      if (changed.changes !== 1) continue;
      if (row.run_kind === "primary") {
        db.prepare(`
          UPDATE work_items SET runtime_state = 'inactive', outcome = 'interrupted',
            wait_kind = NULL, lifecycle_revision = lifecycle_revision + 1,
            last_transition_at = ?, updated_at = ?
          WHERE id = ? AND current_run_key = ? AND outcome = 'completed'
        `).run(at, at, row.work_item_id, row.session_key);
      }
      repaired.push(row.session_key);
    }
    return repaired;
  }).immediate();
}
