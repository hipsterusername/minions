import type Database from "better-sqlite3";
import type { ContributionRow, LineageRow, QueueRow } from "./worktree-integration-repo.ts";

export function getLineageState(db: Database.Database, lineageId: string) {
  return { lineage: (db.prepare("SELECT * FROM worktree_lineages WHERE id=?").get(lineageId) as LineageRow | undefined) ?? null,
    contributions: db.prepare("SELECT * FROM worktree_contributions WHERE lineage_id=? ORDER BY created_at,id")
      .all(lineageId) as ContributionRow[],
    memberships: db.prepare(`SELECT * FROM worktree_lineage_memberships
      WHERE lineage_id=? ORDER BY joined_at,work_item_id`).all(lineageId),
    resolutionRuns: db.prepare(`SELECT * FROM worktree_lineage_resolution_runs
      WHERE lineage_id=? ORDER BY started_at,run_key`).all(lineageId),
    queue: db.prepare("SELECT * FROM worktree_integration_queue WHERE lineage_id=? ORDER BY enqueued_at,id")
      .all(lineageId) as QueueRow[],
    runs: db.prepare(`SELECT r.* FROM worktree_contribution_runs r JOIN worktree_contributions c
      ON c.id=r.contribution_id WHERE c.lineage_id=? ORDER BY r.attached_at,r.run_key`).all(lineageId),
    gates: db.prepare("SELECT * FROM worktree_integration_gates WHERE lineage_id=? ORDER BY recorded_at,id").all(lineageId),
    reviews: db.prepare("SELECT * FROM worktree_integration_reviews WHERE lineage_id=? ORDER BY recorded_at,id").all(lineageId),
    audit: db.prepare("SELECT * FROM worktree_integration_audit WHERE lineage_id=? ORDER BY sequence").all(lineageId) };
}
export function findContributionByRun(db: Database.Database, runKey: string): ContributionRow | undefined {
  return db.prepare(`SELECT c.* FROM worktree_contributions c JOIN worktree_contribution_runs r
    ON r.contribution_id=c.id WHERE r.run_key=?`).get(runKey) as ContributionRow | undefined;
}
export function findOpenLineageByWorkItem(db: Database.Database, workItemId: string): LineageRow | undefined {
  return db.prepare(`SELECT l.* FROM worktree_lineages l JOIN worktree_lineage_memberships m
    ON m.lineage_id=l.id WHERE m.work_item_id=? AND m.status='active' AND l.status='open'
    ORDER BY l.created_at DESC LIMIT 1`).get(workItemId) as LineageRow | undefined;
}
export function findLatestLineageByWorkItem(db: Database.Database, workItemId: string): LineageRow | undefined {
  return db.prepare(`SELECT l.* FROM worktree_lineages l JOIN worktree_lineage_memberships m
    ON m.lineage_id=l.id WHERE m.work_item_id=? ORDER BY m.joined_at DESC,l.created_at DESC LIMIT 1`)
    .get(workItemId) as LineageRow | undefined;
}
export function listProjectLineages(db: Database.Database, projectId: string): LineageRow[] {
  return db.prepare("SELECT * FROM worktree_lineages WHERE project_id=? ORDER BY created_at,id")
    .all(projectId) as LineageRow[];
}
