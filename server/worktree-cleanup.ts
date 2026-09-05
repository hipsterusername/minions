import { worktreePathBusy } from "./commands/worktree-operation-lock.ts";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { exec } from "./worktree-exec.ts";
import { isOwnedWorktreePath } from "./worktree-owned-root.ts";
import { cleanupIntegratedContribution } from "./git-integration-executor.ts";
import { getLineage, getContribution, markContributionCleaned, type QueueRow, type ContributionRow } from "./worktree-integration-repo.ts";

/** Retry terminal cleanup without repeating integration or deleting newly edited checkouts. */
export async function cleanupTerminalWorktrees(db: Database.Database, now = Date.now,
  forceDiscardId?: string): Promise<void> {
  const discarded = db.prepare(`SELECT * FROM worktree_contributions WHERE state='discarded' AND cleanup_state<>'cleaned'`)
    .all() as ContributionRow[];
  for (const row of discarded) {
    const lineage = getLineage(db, row.lineage_id)!;
    if (worktreePathBusy(row.worktree_path)) continue;
    if (db.prepare("SELECT 1 FROM sessions WHERE work_item_id=? AND status='running'").get(row.work_item_id)) continue;
    try {
      if (!isOwnedWorktreePath(lineage.repository_path, row.worktree_path)) continue;
      const ref = row.branch_name.startsWith("refs/") ? row.branch_name : `refs/heads/${row.branch_name}`;
      let head: string | null = null;
      try { head = (await exec(["rev-parse", "--verify", ref], lineage.repository_path)).stdout.trim(); } catch { /* already removed */ }
      if (row.id === forceDiscardId && head) db.prepare("UPDATE worktree_contributions SET head_sha=? WHERE id=? AND state='discarded'").run(head, row.id);
      if (row.id !== forceDiscardId && head && row.head_sha !== head) continue;
      if (fs.existsSync(row.worktree_path)) {
        const branch = (await exec(["symbolic-ref", "--short", "HEAD"], row.worktree_path)).stdout.trim();
        if (branch !== row.branch_name.replace(/^refs\/heads\//, "")) continue;
        await exec(["worktree", "remove", ...(row.id === forceDiscardId ? ["--force"] : []), row.worktree_path], lineage.repository_path);
      }
      if (head) await exec(["update-ref", "-d", ref, head], lineage.repository_path);
      db.prepare("UPDATE worktree_contributions SET cleanup_state='cleaned',revision=revision+1,updated_at=? WHERE id=? AND state='discarded'")
        .run(now(), row.id);
    } catch { /* Retain for a later retry; status remains truthful. */ }
  }
  const completed = db.prepare(`SELECT q.* FROM worktree_integration_queue q
    LEFT JOIN worktree_contributions c ON c.id=q.contribution_id
    WHERE q.state='succeeded' AND ((q.kind='lineage' AND NOT EXISTS
      (SELECT 1 FROM worktree_integration_audit a WHERE a.queue_id=q.id AND a.event='lineage_worktree_cleaned'))
      OR c.cleanup_state='eligible')`).all() as QueueRow[];
  for (const queue of completed) {
    const lineage = getLineage(db, queue.lineage_id)!;
    const row = queue.contribution_id ? getContribution(db, queue.contribution_id) : undefined;
    const sourceRef = row?.branch_name ?? lineage.integration_ref;
    const worktreePath = row?.worktree_path ?? lineage.integration_worktree_path;
    try {
      const cleaned = await cleanupIntegratedContribution({ id: queue.id,
        kind: row ? "integrate_contribution" : "promote_lineage", repositoryPath: lineage.repository_path,
        sourceRef, worktreePath, targetRef: lineage.status === "integrated" ? lineage.target_ref : queue.target_ref, expectedSourceSha: queue.expected_source_sha,
        expectedTargetSha: queue.expected_target_sha, fenceToken: queue.fencing_token }, queue.expected_source_sha, queue.result_sha!);
      if (cleaned && !row) db.prepare(`INSERT INTO worktree_integration_audit
        (lineage_id,queue_id,event,actor,recorded_at) VALUES (?, ?, 'lineage_worktree_cleaned', 'runtime', ?)`)
        .run(lineage.id, queue.id, now());
      if (cleaned && row) markContributionCleaned(db, { contributionId: row.id, integrationQueueId: queue.id,
        workerId: queue.worker_id!, fencingToken: queue.fencing_token, headReachable: true, at: now() });
    } catch { /* Busy/dirty/moved source remains retained, never reset or forced. */ }
  }
}

export function startWorktreeCleanup(db: Database.Database, onError: (error: unknown) => void): () => void {
  let running = false;
  const retry = async () => {
    if (running) return;
    running = true;
    try { await cleanupTerminalWorktrees(db); }
    catch (error) { onError(error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void retry(); }, 30_000);
  timer.unref(); void retry();
  return () => clearInterval(timer);
}
