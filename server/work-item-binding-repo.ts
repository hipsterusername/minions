import type Database from "better-sqlite3";
import { WorkItemConflictError, getWorkItem, type WorkItemBindingRow } from "./work-item-repo.ts";

export function attachWorkItemBinding(db: Database.Database, input: {
  workItemId: string; surface: WorkItemBindingRow["surface"]; bindingId: string; at: number;
}): WorkItemBindingRow {
  if (!getWorkItem(db, input.workItemId)) throw new WorkItemConflictError("work item not found", null);
  try {
    db.prepare(`
      INSERT INTO work_item_bindings (work_item_id, surface, binding_id, attached_at, detached_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(work_item_id, surface, binding_id) DO UPDATE SET
        attached_at = excluded.attached_at, detached_at = NULL
    `).run(input.workItemId, input.surface, input.bindingId, input.at);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new WorkItemConflictError("surface binding is already attached", getWorkItem(db, input.workItemId));
    }
    throw error;
  }
  return db.prepare(`
    SELECT * FROM work_item_bindings WHERE work_item_id = ? AND surface = ? AND binding_id = ?
  `).get(input.workItemId, input.surface, input.bindingId) as WorkItemBindingRow;
}

export function detachWorkItemBinding(
  db: Database.Database, workItemId: string, surface: WorkItemBindingRow["surface"],
  bindingId: string, at: number,
): WorkItemBindingRow {
  if (!getWorkItem(db, workItemId)) throw new WorkItemConflictError("work item not found", null);
  db.prepare(`
    UPDATE work_item_bindings SET detached_at = ?
    WHERE work_item_id = ? AND surface = ? AND binding_id = ? AND detached_at IS NULL
  `).run(at, workItemId, surface, bindingId);
  const row = db.prepare(`
    SELECT * FROM work_item_bindings WHERE work_item_id = ? AND surface = ? AND binding_id = ?
  `).get(workItemId, surface, bindingId) as WorkItemBindingRow | undefined;
  if (!row) throw new WorkItemConflictError("binding not found", getWorkItem(db, workItemId));
  return row;
}
