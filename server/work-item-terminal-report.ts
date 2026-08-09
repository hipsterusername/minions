import type Database from "better-sqlite3";
import type { Outcome } from "../shared/work-item-lifecycle.ts";
import type { WorkItemRunRow } from "./work-item-repo.ts";
import { persistRunReport } from "./work-item-report-repo.ts";

export function persistOptionalRunReport(db: Database.Database, input: {
  workItemId: string;
  runKey: string;
  finalReportEventId?: string | null;
  finalReport?: string | null;
  at: number;
}): void {
  if (!input.finalReportEventId || !input.finalReport) return;
  persistRunReport(db, {
    id: input.finalReportEventId,
    workItemId: input.workItemId,
    runKey: input.runKey,
    text: input.finalReport,
    at: input.at,
  });
}

export function mergeSealedRunReport(db: Database.Database, input: {
  existingRun: WorkItemRunRow;
  workItemId: string;
  runKey: string;
  outcome: Exclude<Outcome, "none">;
  finalReportEventId?: string | null;
  finalReport?: string | null;
  expectedLifecycleRevision?: number;
  expectedCurrentRunKey?: string;
  at: number;
}): { changed: boolean; casConflict: boolean } {
  const reportId = input.finalReportEventId?.trim() || null;
  const report = input.finalReport?.trim() || null;
  const existingReportId = input.existingRun.final_report_event_id;
  const existingReport = input.existingRun.final_report;
  const reportConflict = (reportId !== null && existingReportId !== null
      && reportId !== existingReportId)
    || (report !== null && existingReport !== null && report !== existingReport);
  const addsReport = reportId !== null && report !== null
    && existingReportId === null && existingReport === null;
  const upgradesOutcome = input.existingRun.run_outcome === "interrupted"
    && input.outcome === "completed" && reportId !== null && report !== null;
  if (reportConflict
    || (input.existingRun.run_outcome !== input.outcome && !upgradesOutcome)) {
    throw new Error(`terminal ${input.existingRun.run_kind === "child" ? "child " : ""}run outcome and report are immutable`);
  }
  if (!addsReport && !upgradesOutcome) return { changed: false, casConflict: false };

  let primaryUpgradeRevision: number | null = null;
  if (input.existingRun.run_kind === "primary" && upgradesOutcome) {
    const item = db.prepare(`SELECT current_run_key, lifecycle_revision
      FROM work_items WHERE id = ?`).get(input.workItemId) as
      { current_run_key: string | null; lifecycle_revision: number } | undefined;
    if (item?.current_run_key === input.runKey) {
      if (item.lifecycle_revision !== input.expectedLifecycleRevision
        || item.current_run_key !== input.expectedCurrentRunKey) {
        return { changed: false, casConflict: true };
      }
      primaryUpgradeRevision = item.lifecycle_revision;
    }
  }

  persistOptionalRunReport(db, input);
  if (primaryUpgradeRevision !== null) {
    const upgraded = db.prepare(`UPDATE work_items SET outcome = 'completed',
      lifecycle_revision = lifecycle_revision + 1, last_transition_at = ?, updated_at = ?
      WHERE id = ? AND current_run_key = ? AND lifecycle_revision = ?
        AND runtime_state = 'inactive' AND outcome = 'interrupted'`)
      .run(input.at, input.at, input.workItemId, input.runKey, primaryUpgradeRevision);
    if (upgraded.changes !== 1) return { changed: false, casConflict: true };
  }

  const iso = new Date(input.at).toISOString();
  if (upgradesOutcome || input.existingRun.run_outcome === "completed") {
    db.prepare(`UPDATE sessions SET run_outcome = 'completed',
      final_report_event_id = ?, final_report = ?,
      status = 'idle', review_state = 'completion_to_review',
      review_reason = 'Read the final report and review the dashboard',
      terminal_reason = 'completed',
      final_dashboard_revision = dashboard_revision,
      lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE session_key = ? AND ended_at IS NOT NULL`)
      .run(reportId, report, iso, input.runKey);
  } else {
    db.prepare(`UPDATE sessions SET final_report_event_id = ?, final_report = ?,
      lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE session_key = ? AND ended_at IS NOT NULL`)
      .run(reportId, report, iso, input.runKey);
  }
  return { changed: true, casConflict: false };
}
