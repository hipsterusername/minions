import type Database from "better-sqlite3";
import { getHarness } from "./harness/index.ts";
import { getWorkItem, startWorkItemIteration, WorkItemConflictError } from "./work-item-repo.ts";
import { kanbanCardMetadataSchema } from "../shared/work-item-kanban.ts";

export function startWorkItemIterationForHarness(db: Database.Database,
  input: Parameters<typeof startWorkItemIteration>[1] & { harness: string }) {
  const row = getWorkItem(db, input.workItemId);
  if (!row) throw new WorkItemConflictError("work item not found", null);
  let interception: "complete" | "observe_only" | "none";
  try { interception = getHarness(input.harness).capabilities.mutationInterception; }
  catch { interception = input.harness === "claude" ? "complete" : "observe_only"; }
  // Canonical live mode is truthful only when the adapter can stop a mutation
  // before it executes. Observe-only and non-mutating/unknown adapters both
  // use the isolated workflow so a later capability change cannot silently
  // turn an unenforced live run into a writer.
  const fallback = interception !== "complete";
  if (fallback && row.change_mode === "live") {
    const card = kanbanCardMetadataSchema.parse(JSON.parse(row.kanban_json));
    const changed = db.prepare(`UPDATE work_items SET change_mode = 'worktree',
      integration_state = 'worktree_unprovisioned', kanban_json = ?,
      workflow_revision = workflow_revision + 1, updated_at = ?
      WHERE id = ? AND lifecycle_revision = ? AND current_run_key IS ?`)
      .run(JSON.stringify({ ...card, worktreeIsolation: true }), input.at,
        row.id, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    if (changed.changes !== 1) throw new WorkItemConflictError(
      "stale work-item lifecycle while selecting safe change mode", getWorkItem(db, row.id));
  }
  return startWorkItemIteration(db, input);
}
