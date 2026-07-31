import type Database from "better-sqlite3";

/**
 * Reconcile report records that became durable after their terminal session
 * row. Reports enrich completion but their absence never changes the outcome.
 * A durable report also upgrades rows produced by the former
 * completed-without-report downgrade.
 */
export function repairCompletedRunsWithoutReports(
  db: Database.Database,
  at: number = Date.now(),
): string[] {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT s.session_key, s.work_item_id, s.run_kind, s.run_outcome,
        s.terminal_reason,
        r.id AS report_id, r.report_text
      FROM sessions s
      LEFT JOIN work_item_run_reports r ON r.run_key = s.session_key
      WHERE s.work_item_id IS NOT NULL
        AND s.run_outcome IN ('completed', 'interrupted')
        AND TRIM(COALESCE(s.final_report, '')) = ''
      ORDER BY s.session_key
    `).all() as Array<{
      session_key: string;
      work_item_id: string;
      run_kind: "primary" | "child";
      run_outcome: "completed" | "interrupted";
      terminal_reason: string | null;
      report_id: string | null;
      report_text: string | null;
    }>;
    const repaired: string[] = [];
    for (const row of rows) {
      const reportId = row.report_id?.trim() || null;
      const report = row.report_text?.trim() || null;
      const upgradesOutcome = row.run_outcome === "interrupted"
        && (row.terminal_reason === "completed" || (reportId !== null && report !== null));
      if (!upgradesOutcome && (reportId === null || report === null)) continue;
      const reviewReason = report
        ? "Read the final report and review the dashboard"
        : "Review the completed session";
      const restored = db.prepare(`
        UPDATE sessions SET run_outcome = 'completed',
          final_report_event_id = ?, final_report = ?,
          status = 'idle', review_state = 'completion_to_review',
          review_reason = ?,
          terminal_reason = 'completed',
          final_dashboard_revision = dashboard_revision,
          lifecycle_revision = lifecycle_revision + 1, updated_at = ?
        WHERE session_key = ? AND run_outcome IN ('completed', 'interrupted')
          AND TRIM(COALESCE(final_report, '')) = ''
      `).run(reportId, report, reviewReason,
        new Date(at).toISOString(), row.session_key);
      if (restored.changes !== 1) continue;
      if (row.run_kind === "primary" && upgradesOutcome) {
        db.prepare(`
          UPDATE work_items SET runtime_state = 'inactive', outcome = 'completed',
            lifecycle_revision = lifecycle_revision + 1,
            last_transition_at = ?, updated_at = ?
          WHERE id = ? AND current_run_key = ? AND runtime_state = 'inactive'
            AND outcome = 'interrupted'
        `).run(at, at, row.work_item_id, row.session_key);
      }
      repaired.push(row.session_key);
    }
    return repaired;
  }).immediate();
}
