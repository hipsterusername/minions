import { describe, expect, it } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createWorkItem } from "./work-item-repo.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";
import { createSqliteGitIntegrationStore } from "./sqlite-git-integration-store.ts";
import { addContribution, createLineage, enqueueContribution,
  getQueueEntry, recordContributionReview, recoverInterruptedIntegrations,
  setContributionHead } from "./worktree-integration-repo.ts";

function fixture() {
  const db = initDb(":memory:"); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db);
  createWorkItem(db, { id: "work", projectId: "project", projectPath: "/repo",
    title: "Task", changeMode: "worktree", workflowRank: "a", at: 1 });
  createLineage(db, { id: "lineage", projectId: "project", repositoryPath: "/repo",
    targetRef: "refs/heads/main", baseSha: "base",
    integrationRef: "refs/heads/integration/lineage",
    integrationWorktreePath: "/repo/.canvas-worktrees/integration", at: 2 });
  db.prepare(`INSERT INTO worktree_lineage_memberships
    (lineage_id,work_item_id,actor,joined_at) VALUES ('lineage','work','user',2)`).run();
  const contribution = addContribution(db, { id: "contribution", lineageId: "lineage",
    workItemId: "work", runKey: "run", branchName: "refs/heads/contribution/run",
    worktreePath: "/repo/.canvas-worktrees/run", baseSha: "base", at: 3 });
  const headed = setContributionHead(db, { contributionId: contribution.id,
    expectedRevision: contribution.revision, headSha: "reviewed-head", at: 4 });
  recordContributionReview(db, { id: "review", contributionId: contribution.id,
    expectedRevision: headed.revision, decision: "approved", actor: "user", at: 5 });
  enqueueContribution(db, { id: "queue", lineageId: "lineage",
    contributionId: contribution.id, idempotencyKey: "queue", at: 6 });
  return db;
}

describe("SQLite Git integration worker adapter", () => {
  it("maps persisted refs, paths, reviewed heads, and the claim fence exactly", async () => {
    const db = fixture(); const store = createSqliteGitIntegrationStore(db, () => 7);
    db.prepare("UPDATE worktree_contributions SET head_sha='mutable-later' WHERE id='contribution'").run();
    db.prepare("UPDATE worktree_lineages SET integration_head_sha='mutable-target-later' WHERE id='lineage'").run();
    await expect(store.claimNext("/repo", "refs/heads/integration/lineage", "worker"))
      .resolves.toMatchObject({ id: "queue", kind: "integrate_contribution",
        sourceRef: "refs/heads/contribution/run", targetRef: "refs/heads/integration/lineage",
        worktreePath: "/repo/.canvas-worktrees/run",
        targetWorktreePath: "/repo/.canvas-worktrees/integration",
        expectedSourceSha: "reviewed-head", expectedTargetSha: "base", fenceToken: 1 });
    db.close();
  });

  it("rejects a stale worker completion after recovery and reclaim", async () => {
    const db = fixture(); let at = 7;
    const store = createSqliteGitIntegrationStore(db, () => at++);
    const stale = await store.claimNext("/repo", "refs/heads/integration/lineage", "old");
    expect(stale?.fenceToken).toBe(1);
    recoverInterruptedIntegrations(db, at++);
    const current = await store.claimNext("/repo", "refs/heads/integration/lineage", "new");
    expect(current?.fenceToken).toBe(2);
    await expect(store.finish("queue", "succeeded", { resultSha: "old-result" },
      { workerId: "old", fenceToken: stale!.fenceToken })).rejects.toThrow(/fence/);
    expect(getQueueEntry(db, "queue")).toMatchObject({ state: "running",
      worker_id: "new", fencing_token: 2, result_sha: null });
    await store.finish("queue", "succeeded", { resultSha: "new-result" },
      { workerId: "new", fenceToken: current!.fenceToken });
    expect(getQueueEntry(db, "queue")).toMatchObject({ state: "succeeded",
      result_sha: "new-result" });
    db.close();
  });

  it("persists structured conflict paths for snapshots and recovery", async () => {
    const db = fixture(); const store = createSqliteGitIntegrationStore(db, () => 7);
    const claim = await store.claimNext("/repo", "refs/heads/integration/lineage", "worker");
    await store.finish("queue", "conflicted", { error: "merge conflict", conflictDetails: {
      conflicts: ["src/a.ts"], preservedPaths: ["/repo/.canvas-worktrees/run"],
      targetSha: "base", sourceSha: "reviewed-head" } },
    { workerId: "worker", fenceToken: claim!.fenceToken });
    expect(JSON.parse(getQueueEntry(db, "queue")!.conflict_details_json!)).toEqual({
      conflicts: ["src/a.ts"], preservedPaths: ["/repo/.canvas-worktrees/run"],
      targetSha: "base", sourceSha: "reviewed-head" });
    db.close();
  });
});
