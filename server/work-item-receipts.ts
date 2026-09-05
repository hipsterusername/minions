import type Database from "better-sqlite3";

/** Completed transport responses, separate from intent recorded before launch. */
export function saveWorkItemReceipt(db: Database.Database, requestId: string,
  response: Record<string, unknown>, at: number): void {
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO work_item_receipts (request_id, response_json, created_at)
      VALUES (?, ?, ?)`).run(requestId, JSON.stringify(response), at);
    db.prepare(`DELETE FROM work_item_receipts WHERE created_at < ? OR request_id IN (
      SELECT request_id FROM work_item_receipts ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 1000
    )`).run(at - 7 * 24 * 60 * 60 * 1000);
  })();
}

export function getWorkItemReceipt(db: Database.Database, requestId: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT response_json FROM work_item_receipts WHERE request_id = ?")
    .get(requestId) as { response_json: string } | undefined;
  return row ? JSON.parse(row.response_json) as Record<string, unknown> : null;
}
