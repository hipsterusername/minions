import type Database from "better-sqlite3";
import { detachWorkItemBinding } from "./work-item-binding-repo.ts";
import { recoverOrphanedWorkItemRuns } from "./work-item-migration.ts";
import { recoverInterruptedIntegrations } from "./worktree-integration-repo.ts";

export type RepairFindingCode = "orphan_canvas_binding" | "unverifiable_canvas_binding"
  | "missing_active_worktree" | "stale_eligible_worktree"
  | "unsealed_run" | "stale_running_queue";
export interface WorkItemRepairFinding {
  code: RepairFindingCode;
  workItemId: string;
  projectPath: string;
  bindingId: string;
  repaired: boolean;
}

export type CanvasBindingInspector = (input: {
  projectPath: string; bindingId: string; workItemId: string;
}) => boolean | null;

/**
 * Audit durable Canvas bindings against the owning project sidecar. `null`
 * means the project cannot be inspected and is deliberately report-only;
 * only a definitive missing/mismatched node is safe to detach.
 */
export function auditAndRepairCanvasBindings(input: {
  db: Database.Database;
  inspect: CanvasBindingInspector;
  repair?: boolean;
  at?: number;
}): WorkItemRepairFinding[] {
  const rows = input.db.prepare(`SELECT b.work_item_id,b.binding_id,w.project_path
    FROM work_item_bindings b JOIN work_items w ON w.id=b.work_item_id
    WHERE b.surface='canvas' AND b.detached_at IS NULL ORDER BY b.work_item_id,b.binding_id`)
    .all() as Array<{ work_item_id: string; binding_id: string; project_path: string }>;
  return input.db.transaction(() => rows.flatMap((row) => {
    const exists = input.inspect({ workItemId: row.work_item_id,
      bindingId: row.binding_id, projectPath: row.project_path });
    if (exists === true) return [];
    const repaired = exists === false && input.repair === true;
    if (repaired) detachWorkItemBinding(input.db, row.work_item_id, "canvas",
      row.binding_id, input.at ?? Date.now());
    return [{ code: exists === null ? "unverifiable_canvas_binding" : "orphan_canvas_binding",
      workItemId: row.work_item_id, projectPath: row.project_path,
      bindingId: row.binding_id, repaired } satisfies WorkItemRepairFinding];
  }))();
}

export interface WorktreeRepairFinding {
  code: Extract<RepairFindingCode, "missing_active_worktree" | "stale_eligible_worktree">;
  contributionId: string; worktreePath: string; pathState: "missing" | "clean" | "dirty";
  repaired: boolean;
}

/** Classify durable contribution paths; only a missing, cleanup-eligible path is auto-repairable. */
export function auditAndRepairContributionWorktrees(input: {
  db: Database.Database; inspectPath: (path: string) => "missing" | "clean" | "dirty";
  repair?: boolean; at?: number;
}): WorktreeRepairFinding[] {
  const rows = input.db.prepare(`SELECT id,worktree_path,state,cleanup_state
    FROM worktree_contributions WHERE cleanup_state <> 'cleaned' ORDER BY id`).all() as
    Array<{ id: string; worktree_path: string; state: string; cleanup_state: string }>;
  return input.db.transaction(() => rows.flatMap((row) => {
    const pathState = input.inspectPath(row.worktree_path);
    const eligible = row.cleanup_state === "eligible";
    if (!eligible && pathState !== "missing") return [];
    const repaired = eligible && pathState === "missing" && input.repair === true;
    if (repaired) input.db.prepare(`UPDATE worktree_contributions SET cleanup_state='cleaned',
      revision=revision+1,updated_at=? WHERE id=? AND cleanup_state='eligible'`)
      .run(input.at ?? Date.now(), row.id);
    return [{ code: eligible ? "stale_eligible_worktree" : "missing_active_worktree",
      contributionId: row.id, worktreePath: row.worktree_path, pathState, repaired } as WorktreeRepairFinding];
  }))();
}

export interface RuntimeRepairFinding {
  code: Extract<RepairFindingCode, "unsealed_run">;
  workItemId: string;
  runKey: string;
  runKind: "primary" | "child";
  repaired: boolean;
}

/** Report and optionally seal canonical runs that have no live harness. */
export function auditAndRepairUnsealedRuns(input: {
  db: Database.Database;
  liveRunKeys?: ReadonlySet<string>;
  repair?: boolean;
  at?: number;
}): RuntimeRepairFinding[] {
  const live = input.liveRunKeys ?? new Set<string>();
  const rows = input.db.prepare(`SELECT work_item_id,session_key,run_kind FROM sessions
    WHERE work_item_id IS NOT NULL AND ended_at IS NULL AND run_outcome='none'
    ORDER BY session_key`).all() as Array<{
      work_item_id: string; session_key: string; run_kind: "primary" | "child";
    }>;
  const orphaned = rows.filter((row) => !live.has(row.session_key));
  const recovered = input.repair
    ? new Set(recoverOrphanedWorkItemRuns(input.db, live, input.at ?? Date.now()).recoveredRunKeys)
    : new Set<string>();
  return orphaned.map((row) => ({
    code: "unsealed_run",
    workItemId: row.work_item_id,
    runKey: row.session_key,
    runKind: row.run_kind,
    repaired: recovered.has(row.session_key),
  }));
}

export interface QueueRepairFinding {
  code: Extract<RepairFindingCode, "stale_running_queue">;
  queueId: string;
  lineageId: string;
  repaired: boolean;
}

/** Report and optionally requeue entries whose integration worker disappeared. */
export function auditAndRepairRunningQueue(input: {
  db: Database.Database;
  repair?: boolean;
  at?: number;
}): QueueRepairFinding[] {
  const rows = input.db.prepare(`SELECT id,lineage_id FROM worktree_integration_queue
    WHERE state='running' ORDER BY started_at,id`).all() as Array<{ id: string; lineage_id: string }>;
  const recovered = input.repair
    ? new Set(recoverInterruptedIntegrations(input.db, input.at ?? Date.now()))
    : new Set<string>();
  return rows.map((row) => ({ code: "stale_running_queue", queueId: row.id,
    lineageId: row.lineage_id, repaired: recovered.has(row.id) }));
}
