import type Database from "better-sqlite3";

export function syncResolutionToCurrentSession(db: Database.Database, input: {
  runKey: string | null; workItemId: string; action: "review" | "archive" | "restore";
  lifecycleRevision: number; at: number;
}): void {
  if (!input.runKey) return;
  const column = input.action === "review" ? "acknowledged_at" : "dismissed_at";
  const value = input.action === "restore" ? null : input.at;
  db.prepare(`UPDATE sessions SET ${column} = ?, lifecycle_revision = ?, updated_at = ?
    WHERE session_key = ? AND work_item_id = ?`)
    .run(value, input.lifecycleRevision, new Date(input.at).toISOString(), input.runKey, input.workItemId);
}
