import type Database from "better-sqlite3";
import type { GitConflictDetails, GitIntegrationOperation, GitIntegrationStore } from "./git-integration-types.ts";
import { claimNext, finishIntegration, getContribution, getLineage,
  markContributionCleaned } from "./worktree-integration-repo.ts";
import { requeueRunning } from "./worktree-integration-operations.ts";

export class SqliteGitIntegrationStore implements GitIntegrationStore {
  constructor(private readonly db: Database.Database, private readonly now = Date.now,
    private readonly onChanged?: (lineageId: string) => void) {}
  private notify(lineageId: string): void { try { this.onChanged?.(lineageId); } catch { /* observer only */ } }
  async claimNext(repositoryPath: string, targetRef: string,
    workerId: string): Promise<GitIntegrationOperation | null> {
    const queue = claimNext(this.db, { repositoryPath, targetRef, workerId, at: this.now() });
    if (!queue) return null;
    this.notify(queue.lineage_id);
    const lineage = getLineage(this.db, queue.lineage_id);
    if (!lineage) throw new Error("claimed integration lineage not found");
    if (queue.kind === "contribution") {
      const contribution = queue.contribution_id
        ? getContribution(this.db, queue.contribution_id) : undefined;
      if (!contribution?.head_sha) throw new Error("claimed contribution head not found");
      return { id: queue.id, kind: "integrate_contribution",
        repositoryPath: lineage.repository_path, targetRef: lineage.integration_ref,
        targetWorktreePath: lineage.integration_worktree_path,
        sourceRef: contribution.branch_name, worktreePath: contribution.worktree_path,
        contributionId: contribution.id, lineageId: lineage.id, workItemId: contribution.work_item_id,
        projectId: lineage.project_id,
        expectedSourceSha: queue.expected_source_sha,
        expectedTargetSha: queue.expected_target_sha,
        fenceToken: queue.fencing_token };
    }
    return { id: queue.id, kind: "promote_lineage",
      repositoryPath: lineage.repository_path, targetRef: lineage.target_ref,
      sourceRef: lineage.integration_ref, worktreePath: lineage.integration_worktree_path,
      contributionId: null, lineageId: lineage.id, projectId: lineage.project_id,
      expectedSourceSha: queue.expected_source_sha,
      expectedTargetSha: queue.expected_target_sha, fenceToken: queue.fencing_token };
  }
  async finish(entryId: string, status: "succeeded" | "conflicted" | "failed",
    detail: { resultSha?: string; error?: string; conflictDetails?: GitConflictDetails },
    claim: { workerId: string; fenceToken: string | number }): Promise<void> {
    const changed = finishIntegration(this.db, { queueId: entryId, workerId: claim.workerId,
      fencingToken: Number(claim.fenceToken), outcome: status,
      ...(detail.resultSha ? { resultSha: detail.resultSha } : {}),
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.conflictDetails ? { conflictDetails: detail.conflictDetails } : {}), at: this.now() });
    this.notify(changed.lineage_id);
  }
  async requeue(entryId: string, reason: string,
    claim: { workerId: string; fenceToken: string | number }): Promise<void> {
    const changed = requeueRunning(this.db, { queueId: entryId, workerId: claim.workerId,
      fencingToken: Number(claim.fenceToken), reason, at: this.now() });
    this.notify(changed.lineage_id);
  }
  async markCleaned(contributionId: string, detail: { headReachable: true;
    queueId: string; resultSha: string },
    claim: { workerId: string; fenceToken: string | number }): Promise<void> {
    const changed = markContributionCleaned(this.db, { contributionId,
      integrationQueueId: detail.queueId, workerId: claim.workerId,
      fencingToken: Number(claim.fenceToken),
      headReachable: detail.headReachable, at: this.now() });
    this.notify(changed.lineage_id);
  }
}

export function createSqliteGitIntegrationStore(db: Database.Database,
  now: () => number = Date.now, onChanged?: (lineageId: string) => void): GitIntegrationStore {
  return new SqliteGitIntegrationStore(db, now, onChanged);
}
