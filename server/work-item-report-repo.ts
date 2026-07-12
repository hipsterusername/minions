import type Database from "better-sqlite3";

export function persistRunReport(db: Database.Database, input: {
  id: string; workItemId: string; runKey: string; text: string; at: number;
}): void {
  const text = input.text.trim();
  if (!input.id.trim() || !text) throw new Error("durable run report requires id and text");
  const existing = db.prepare(`SELECT work_item_id, run_key, report_text FROM work_item_run_reports
    WHERE id = ? OR run_key = ?`).get(input.id, input.runKey) as
    { work_item_id: string; run_key: string; report_text: string } | undefined;
  if (existing) {
    if (existing.work_item_id !== input.workItemId || existing.run_key !== input.runKey || existing.report_text !== text)
      throw new Error("durable run report is immutable");
    return;
  }
  db.prepare(`INSERT INTO work_item_run_reports
    (id, work_item_id, run_key, report_text, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(input.id, input.workItemId, input.runKey, text, input.at);
}
