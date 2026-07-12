import type Database from "better-sqlite3";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import * as repo from "./worktree-integration-repo.ts";

export function snapshotWorktreeLineage(db: Database.Database,
  raw: ReturnType<typeof repo.getLineageState>): WorktreeLineageSnapshot | null {
  const lineage = raw.lineage; if (!lineage) return null; const runKeys = new Map<string, string[]>();
  for (const run of raw.runs as Array<{ contribution_id: string; run_key: string }>)
    runKeys.set(run.contribution_id, [...(runKeys.get(run.contribution_id) ?? []), run.run_key]);
  return { id: lineage.id, projectId: lineage.project_id, repositoryPath: lineage.repository_path,
    targetRef: lineage.target_ref, baseSha: lineage.base_sha, integrationRef: lineage.integration_ref,
    integrationWorktreePath: lineage.integration_worktree_path, integrationHeadSha: lineage.integration_head_sha,
    integrationState: lineage.integration_state, revision: lineage.revision, status: lineage.status,
    memberships: (raw.memberships as Array<Record<string, unknown>>).map((row) => ({
      workItemId: String(row["work_item_id"]), status: row["status"] as "active" | "left",
      revision: Number(row["revision"]), actor: String(row["actor"]), joinedAt: Number(row["joined_at"]),
      leftAt: row["left_at"] == null ? null : Number(row["left_at"]) })),
    resolutionRuns: (raw.resolutionRuns as Array<Record<string, unknown>>).map((row) => ({
      lineageId: String(row["lineage_id"]), runKey: String(row["run_key"]), workItemId: String(row["work_item_id"]),
      state: row["state"] as "active" | "resolved" | "failed", revision: Number(row["revision"]),
      headSha: row["head_sha"] as string | null, error: row["error"] as string | null,
      startedAt: Number(row["started_at"]), finishedAt: row["finished_at"] == null ? null : Number(row["finished_at"]) })),
    contributions: raw.contributions.map((row) => ({ id: row.id, lineageId: row.lineage_id,
      workItemId: row.work_item_id, originatingRunKey: row.originating_run_key,
      runKeys: runKeys.get(row.id) ?? [row.originating_run_key], branchName: row.branch_name,
      worktreePath: row.worktree_path, baseSha: row.base_sha, headSha: row.head_sha,
      revision: row.revision, state: row.state, reviewState: row.review_state,
      cleanupState: row.cleanup_state, createdAt: row.created_at, updatedAt: row.updated_at })),
    queue: raw.queue.map((row) => ({ id: row.id, lineageId: row.lineage_id,
      contributionId: row.contribution_id, kind: row.kind, repositoryPath: row.repository_path,
      targetRef: row.target_ref, expectedSourceSha: row.expected_source_sha,
      expectedTargetSha: row.expected_target_sha, revision: row.revision, state: row.state,
      attempt: row.attempt, workerId: row.worker_id, fencingToken: row.fencing_token,
      resultSha: row.result_sha, error: row.error, conflictDetails: row.conflict_details_json
        ? JSON.parse(row.conflict_details_json) as { conflicts: string[]; preservedPaths: string[];
          targetSha: string; sourceSha: string } : null, position: repo.getQueuePosition(db, row.id),
      enqueuedAt: row.enqueued_at, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at })),
    gates: (raw.gates as Array<Record<string, unknown>>).map((row) => ({ id: String(row["id"]),
      lineageId: String(row["lineage_id"]), contributionId: row["contribution_id"] as string | null,
      scope: row["scope"] as "contribution" | "lineage", name: String(row["name"]),
      status: row["status"] as "pending" | "passed" | "failed" | "waived",
      details: row["details"] as string | null, recordedAt: Number(row["recorded_at"]) })),
    reviews: (raw.reviews as Array<Record<string, unknown>>).map((row) => ({ id: String(row["id"]),
      lineageId: String(row["lineage_id"]), contributionId: row["contribution_id"] as string | null,
      scope: row["scope"] as "contribution" | "lineage", decision: row["decision"] as "approved" | "rejected",
      actor: String(row["actor"]), notes: row["notes"] as string | null,
      reviewedHeadSha: row["reviewed_head_sha"] as string | null, recordedAt: Number(row["recorded_at"]) })),
    createdAt: lineage.created_at, updatedAt: lineage.updated_at };
}
