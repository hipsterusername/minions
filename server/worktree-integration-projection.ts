import type Database from "better-sqlite3";
import { getWorkItem } from "./work-item-repo.ts";
import type { IntegrationState } from "../shared/work-item-lifecycle.ts";

export type DurableIntegrationProjection =
  | "planned" | "provisioning" | "active" | "ready" | "queued" | "integrating"
  | "conflicted" | "failed" | "discarded" | "contribution_integrated" | "lineage_integrated";

export function integrationStateForDurableState(state: DurableIntegrationProjection): IntegrationState {
  if (state === "planned" || state === "provisioning") return "worktree_unprovisioned";
  if (state === "active" || state === "ready" || state === "contribution_integrated") return "worktree_active";
  if (state === "queued") return "worktree_queued";
  if (state === "integrating") return "worktree_integrating";
  if (state === "conflicted" || state === "failed") return "worktree_conflicted";
  if (state === "discarded") return "worktree_discarded";
  return "worktree_integrated";
}

/** CAS the canonical item from an authoritative durable integration transition. */
export function applyWorkItemIntegrationProjection(db: Database.Database, input: {
  workItemId: string; state: DurableIntegrationProjection; at: number;
}): ReturnType<typeof getWorkItem> {
  return db.transaction(() => {
    return projectWorkItemIntegrationState(db, input);
  }).immediate();
}

/** Apply a projection inside the caller's authoritative transaction. */
export function projectWorkItemIntegrationState(db: Database.Database, input: {
  workItemId: string; state: DurableIntegrationProjection; at: number;
}): ReturnType<typeof getWorkItem> {
  const row = getWorkItem(db, input.workItemId); if (!row) throw new Error("work item not found");
  if (row.change_mode !== "worktree") throw new Error("worktree item required");
  const integration = integrationStateForDurableState(input.state);
  if (row.integration_state === integration) return row;
  const changed = db.prepare(`UPDATE work_items SET integration_state=?,lifecycle_revision=lifecycle_revision+1,
    last_transition_at=?,updated_at=? WHERE id=? AND lifecycle_revision=?`)
    .run(integration, input.at, input.at, row.id, row.lifecycle_revision);
  if (changed.changes !== 1) throw new Error("concurrent work-item integration projection");
  return getWorkItem(db, row.id);
}
