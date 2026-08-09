import type Database from "better-sqlite3";
import { getLineage } from "./worktree-integration-repo.ts";

export interface LineageMembershipRow { lineage_id: string; work_item_id: string;
  status: "active" | "left"; revision: number; actor: string; joined_at: number; left_at: number | null }
export function findActiveLineageMembership(db: Database.Database, workItemId: string) {
  return db.prepare(`SELECT * FROM worktree_lineage_memberships
    WHERE work_item_id=? AND status='active'`).get(workItemId) as LineageMembershipRow | undefined;
}
export function joinWorkItemLineage(db: Database.Database, input: { lineageId: string;
  workItemId: string; expectedLineageRevision: number; actor: string; at: number }): LineageMembershipRow {
  return db.transaction(() => {
    const lineage = getLineage(db, input.lineageId);
    if (!lineage || lineage.status !== "open" || lineage.revision !== input.expectedLineageRevision)
      throw new Error("open lineage revision required");
    const item = db.prepare("SELECT project_id,project_path,change_mode FROM work_items WHERE id=?")
      .get(input.workItemId) as { project_id: string; project_path: string;
        change_mode: "live" | "worktree" } | undefined;
    if (!item || item.project_id !== lineage.project_id || item.project_path !== lineage.repository_path)
      throw new Error("work item and lineage project ownership must match");
    if (item.change_mode !== "worktree") throw new Error("live work items cannot join worktree lineages");
    db.prepare(`UPDATE worktree_lineage_memberships SET status='left',revision=revision+1,left_at=?
      WHERE work_item_id=? AND status='active' AND lineage_id IN
        (SELECT id FROM worktree_lineages WHERE status<>'open')`).run(input.at, input.workItemId);
    const active = findActiveLineageMembership(db, input.workItemId);
    if (active) {
      if (active.lineage_id === lineage.id) return active;
      throw new Error("work item already belongs to an active lineage");
    }
    db.prepare(`INSERT INTO worktree_lineage_memberships
      (lineage_id,work_item_id,status,actor,joined_at) VALUES (?, ?, 'active', ?, ?)
      ON CONFLICT(lineage_id,work_item_id) DO UPDATE SET status='active',revision=revision+1,
        actor=excluded.actor,joined_at=excluded.joined_at,left_at=NULL`)
      .run(lineage.id, input.workItemId, input.actor, input.at);
    db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=? AND revision=?")
      .run(input.at, lineage.id, input.expectedLineageRevision);
    db.prepare(`INSERT INTO worktree_integration_audit
      (lineage_id,event,actor,details,recorded_at) VALUES (?, 'work_item_joined', ?, ?, ?)`)
      .run(lineage.id, input.actor, JSON.stringify({ workItemId: input.workItemId }), input.at);
    return findActiveLineageMembership(db, input.workItemId)!;
  }).immediate();
}
export function leaveWorkItemLineage(db: Database.Database, input: { workItemId: string;
  expectedRevision: number; actor: string; at: number }): LineageMembershipRow {
  return db.transaction(() => {
    const row = findActiveLineageMembership(db, input.workItemId);
    if (!row || row.revision !== input.expectedRevision) throw new Error("active membership revision required");
    db.prepare(`UPDATE worktree_lineage_memberships SET status='left',revision=revision+1,left_at=?
      WHERE lineage_id=? AND work_item_id=? AND revision=?`).run(input.at, row.lineage_id,
        row.work_item_id, input.expectedRevision);
    db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=?")
      .run(input.at, row.lineage_id);
    db.prepare(`INSERT INTO worktree_integration_audit
      (lineage_id,event,actor,details,recorded_at) VALUES (?, 'work_item_left', ?, ?, ?)`)
      .run(row.lineage_id, input.actor, JSON.stringify({ workItemId: input.workItemId }), input.at);
    return db.prepare(`SELECT * FROM worktree_lineage_memberships
      WHERE lineage_id=? AND work_item_id=?`).get(row.lineage_id, row.work_item_id) as LineageMembershipRow;
  }).immediate();
}
