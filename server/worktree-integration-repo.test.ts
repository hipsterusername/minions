import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createWorkItem, getWorkItem } from "./work-item-repo.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";
import { executeIntegrationCommand, IntegrationIdempotencyMismatchError } from "./worktree-integration-ledger.ts";
import * as repo from "./worktree-integration-repo.ts";
import { joinWorkItemLineage } from "./worktree-lineage-membership-repo.ts";
import { adoptLegacyContribution, requeueRunning, resolveLineagePromotionConflict,
  attachLineageResolutionRun, completeLineageResolutionRun,
  transitionContributionProvisioning } from "./worktree-integration-operations.ts";

describe("worktree lineage persistence", () => {
  let db: Database.Database; const files: string[] = [];
  beforeEach(() => { db = initDb(":memory:"); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db);
    createWorkItem(db, { id: "work", projectId: "project", projectPath: "/repo",
      title: "Task", changeMode: "worktree", at: 1 }); });
  afterEach(() => { db.close(); for (const file of files.splice(0)) fs.rmSync(file, { force: true }); });
  function lineage(at = 2) { const created = repo.createLineage(db, { id: "lineage", projectId: "project",
    repositoryPath: "/repo", targetRef: "refs/heads/main", baseSha: "base",
    integrationRef: "refs/heads/integration/lineage", integrationWorktreePath: "/repo/.wt/integration",
    at }); joinWorkItemLineage(db, { lineageId: created.id, workItemId: "work",
      expectedLineageRevision: created.revision, actor: "owner", at: at + 0.1 });
    return repo.getLineage(db, created.id)!; }
  function contribution(at = 3) { return repo.addContribution(db, { id: "contribution", lineageId: "lineage",
    workItemId: "work", runKey: "run-1", branchName: "refs/heads/work/run-1",
    worktreePath: "/repo/.wt/run-1", baseSha: "base", at }); }
  function ready() { const row = contribution(); const headed = repo.setContributionHead(db,
    { contributionId: row.id, expectedRevision: row.revision, headSha: "head-1", at: 4 });
    return repo.recordContributionReview(db, { id: "review", contributionId: row.id,
      expectedRevision: headed.revision, decision: "approved", actor: "user", at: 5 }); }

  it("persists anchored refs/paths and maps conflict-resolution runs without deriving branches", () => {
    const l = lineage(); const c = contribution();
    expect(l).toMatchObject({ project_id: "project", target_ref: "refs/heads/main",
      integration_ref: "refs/heads/integration/lineage", integration_worktree_path: "/repo/.wt/integration" });
    expect(c).toMatchObject({ branch_name: "refs/heads/work/run-1", worktree_path: "/repo/.wt/run-1" });
    db.prepare("UPDATE worktree_contributions SET state='conflicted' WHERE id=?").run(c.id);
    const resolved = repo.attachResolutionRun(db, { contributionId: c.id,
      expectedRevision: c.revision, runKey: "run-2", at: 6 });
    expect(resolved).toMatchObject({ branch_name: c.branch_name, worktree_path: c.worktree_path, state: "active" });
    expect(repo.findContributionByRun(db, "run-2")?.id).toBe(c.id);
  });

  it("attaches an ordinary repeated iteration to the existing branch/worktree", () => {
    lineage(); const original = contribution();
    const headed = repo.setContributionHead(db, { contributionId: original.id,
      expectedRevision: original.revision, headSha: "head", at: 4 });
    const reused = repo.attachContributionIteration(db, { contributionId: original.id,
      expectedRevision: headed.revision, runKey: "run-next", at: 5 });
    expect(reused).toMatchObject({ state: "active", review_state: "pending",
      branch_name: original.branch_name, worktree_path: original.worktree_path });
    expect(repo.findContributionByRun(db, "run-next")?.id).toBe(original.id);
  });

  it("freezes contribution approval to its reviewed head and invalidates gates on change", () => {
    lineage(); const original = contribution();
    repo.recordGate(db, { id: "gate", contributionId: original.id,
      name: "tests", status: "passed", at: 3.5 });
    let current = repo.getContribution(db, original.id)!;
    const headed = repo.setContributionHead(db, { contributionId: original.id,
      expectedRevision: current.revision, headSha: "head-1", at: 4 });
    expect(repo.getLineageState(db, "lineage").gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "pending" })]));
    const approved = repo.recordContributionReview(db, { id: "review-1", contributionId: original.id,
      expectedRevision: headed.revision, decision: "approved", actor: "user", at: 5 });
    expect(repo.getLineageState(db, "lineage").reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewed_head_sha: "head-1" })]));
    repo.recordGate(db, { id: "ignored", contributionId: original.id,
      name: "tests", status: "passed", at: 5.5 });
    current = repo.getContribution(db, original.id)!;
    const changed = repo.setContributionHead(db, { contributionId: original.id,
      expectedRevision: current.revision, headSha: "head-2", at: 6 });
    expect(() => repo.enqueueContribution(db, { id: "stale", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "stale", at: 7 })).toThrow();
    expect(changed.review_state).toBe("pending");
    expect(repo.getLineageState(db, "lineage").gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "pending" })]));
  });

  it("freezes queued contribution heads and transactionally projects worker transitions", () => {
    lineage(); const approved = ready(); repo.enqueueContribution(db, { id: "q", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue", at: 6 });
    expect(getWorkItem(db, "work")?.integration_state).toBe("worktree_queued");
    expect(() => repo.setContributionHead(db, { contributionId: approved.id,
      expectedRevision: repo.getContribution(db, approved.id)!.revision, headSha: "late", at: 7 }))
      .toThrow(/frozen/);
    const running = repo.claimNext(db, { repositoryPath: "/repo",
      targetRef: "refs/heads/integration/lineage", workerId: "worker", at: 8 })!;
    expect(getWorkItem(db, "work")?.integration_state).toBe("worktree_integrating");
    repo.finishIntegration(db, { queueId: running.id, workerId: "worker",
      fencingToken: running.fencing_token, outcome: "conflicted", error: "merge", at: 9 });
    expect(getWorkItem(db, "work")?.integration_state).toBe("worktree_conflicted");
  });

  it("persists a fenced lineage conflict-resolution run and resolves the verified head", () => {
    lineage(); db.prepare("UPDATE worktree_lineages SET integration_state='conflicted' WHERE id='lineage'").run();
    let current = repo.getLineage(db, "lineage")!;
    const attached = attachLineageResolutionRun(db, { lineageId: current.id, workItemId: "work",
      runKey: "resolution-run", expectedLineageRevision: current.revision, actor: "owner", at: 4 });
    expect(attached).toMatchObject({ state: "active", work_item_id: "work" });
    expect(() => attachLineageResolutionRun(db, { lineageId: current.id, workItemId: "work",
      runKey: "other", expectedLineageRevision: current.revision + 1, actor: "owner", at: 5 })).toThrow();
    current = repo.getLineage(db, "lineage")!;
    const done = completeLineageResolutionRun(db, { runKey: attached.run_key,
      expectedRunRevision: attached.revision, expectedLineageRevision: current.revision,
      integrationHeadSha: "verified-integration-head", actor: "runtime", at: 6 });
    expect(done).toMatchObject({ state: "resolved", head_sha: "verified-integration-head", finished_at: 6 });
    expect(repo.getLineage(db, "lineage")).toMatchObject({ integration_state: "active",
      integration_head_sha: "verified-integration-head" });
  });

  it("supports multiple work items in one lineage and retires terminal memberships", () => {
    createWorkItem(db, { id: "work-2", projectId: "project", projectPath: "/repo",
      title: "Second", changeMode: "worktree", at: 1 });
    const first = lineage(); const joined = joinWorkItemLineage(db, { lineageId: first.id,
      workItemId: "work-2", expectedLineageRevision: first.revision, actor: "owner", at: 3 });
    expect(joined.status).toBe("active");
    db.prepare("UPDATE worktree_lineages SET status='integrated' WHERE id=?").run(first.id);
    const next = repo.createLineage(db, { id: "next", projectId: "project", repositoryPath: "/repo",
      targetRef: "refs/heads/main", baseSha: "next-base", integrationRef: "refs/heads/integration/next",
      integrationWorktreePath: "/repo/.wt/next", at: 4 });
    expect(joinWorkItemLineage(db, { lineageId: next.id, workItemId: "work-2",
      expectedLineageRevision: next.revision, actor: "owner", at: 5 }).lineage_id).toBe("next");
  });

  it("rejects membership across project/repository ownership", () => {
    createWorkItem(db, { id: "foreign", projectId: "other", projectPath: "/other",
      title: "Foreign", changeMode: "worktree", at: 1 });
    const created = lineage();
    expect(() => joinWorkItemLineage(db, { lineageId: created.id, workItemId: "foreign",
      expectedLineageRevision: created.revision, actor: "owner", at: 3 })).toThrow(/ownership/);
  });

  it("persists provisioning transitions and adopts a legacy branch without rewriting its SHAs", () => {
    lineage(); const planned = repo.addContribution(db, { id: "planned", lineageId: "lineage",
      workItemId: "work", runKey: "planned-run", branchName: "refs/heads/planned",
      worktreePath: "/repo/.wt/planned", baseSha: "base", state: "planned", at: 3 });
    const provisioning = transitionContributionProvisioning(db, { contributionId: planned.id,
      expectedRevision: planned.revision, outcome: "provisioning", at: 4 });
    expect(transitionContributionProvisioning(db, { contributionId: planned.id,
      expectedRevision: provisioning.revision, outcome: "active", at: 5 }).state).toBe("active");
    db.prepare("DELETE FROM worktree_contribution_runs WHERE contribution_id=?").run(planned.id);
    db.prepare("DELETE FROM worktree_contributions WHERE id=?").run(planned.id);
    expect(adoptLegacyContribution(db, { id: "legacy", lineageId: "lineage", workItemId: "work",
      runKey: "legacy-run", branchName: "refs/heads/existing", worktreePath: "/repo/existing",
      baseSha: "old-base", headSha: "existing-head", actor: "migration", at: 6 }))
      .toMatchObject({ base_sha: "old-base", head_sha: "existing-head", branch_name: "refs/heads/existing" });
  });

  it("requeues a running operation only with its current worker fence", () => {
    lineage(); const approved = ready(); repo.enqueueContribution(db, { id: "q", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue", at: 6 });
    const running = repo.claimNext(db, { repositoryPath: "/repo",
      targetRef: "refs/heads/integration/lineage", workerId: "worker", at: 7 })!;
    expect(() => requeueRunning(db, { queueId: "q", workerId: "stale",
      fencingToken: running.fencing_token, reason: "target busy", at: 8 })).toThrow(/fence/);
    expect(requeueRunning(db, { queueId: "q", workerId: "worker",
      fencingToken: running.fencing_token, reason: "target busy", at: 9 }).state).toBe("queued");
  });

  it("queues idempotently/FIFO under integration-ref scope and keeps terminal rows immutable", () => {
    lineage(); const approved = ready();
    const queued = repo.enqueueContribution(db, { id: "q1", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue-1", at: 6 });
    expect(queued.target_ref).toBe("refs/heads/integration/lineage");
    expect(repo.enqueueContribution(db, { id: "ignored", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue-1", at: 7 }).id).toBe("q1");
    const running = repo.claimNext(db, { repositoryPath: "/repo",
      targetRef: "refs/heads/integration/lineage", workerId: "worker", at: 8 });
    expect(running).toMatchObject({ id: "q1", state: "running", worker_id: "worker" });
    expect(repo.claimNext(db, { repositoryPath: "/repo",
      targetRef: "refs/heads/integration/lineage", workerId: "other", at: 9 })).toBeNull();
    expect(repo.finishIntegration(db, { queueId: "q1", workerId: "worker",
      fencingToken: running!.fencing_token, outcome: "failed", error: "boom", at: 10 }))
      .toMatchObject({ state: "failed", error: "boom" });
    expect(() => repo.finishIntegration(db, { queueId: "q1", workerId: "worker",
      fencingToken: running!.fencing_token, outcome: "succeeded", resultSha: "late", at: 11 }))
      .toThrow(/running/);
    expect(repo.retryIntegration(db, { priorQueueId: "q1", id: "q2",
      idempotencyKey: "retry-1", at: 12 })).toMatchObject({ state: "queued", attempt: 2 });
  });

  it("computes repository/target-scoped FIFO positions across lineages", () => {
    lineage();
    db.prepare(`INSERT INTO worktree_integration_queue
      (id,lineage_id,kind,repository_path,target_ref,idempotency_key,expected_source_sha,
       expected_target_sha,enqueued_at,updated_at) VALUES
      ('later','lineage','lineage','/repo','refs/heads/main','later','source','target',10,10),
      ('earlier','lineage','lineage','/repo','refs/heads/main','earlier','source','target',9,9)`).run();
    expect(repo.getQueuePosition(db, "earlier")).toBe(1);
    expect(repo.getQueuePosition(db, "later")).toBe(2);
    repo.claimNext(db, { repositoryPath: "/repo", targetRef: "refs/heads/main", workerId: "worker", at: 11 });
    expect(repo.getQueuePosition(db, "earlier")).toBeNull();
    expect(repo.getQueuePosition(db, "later")).toBe(1);
  });

  it("recovers crash-left running work as queued and records audit", () => {
    lineage(); const approved = ready(); repo.enqueueContribution(db, { id: "q", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue", at: 6 });
    const stale = repo.claimNext(db, { repositoryPath: "/repo", targetRef: "refs/heads/integration/lineage",
      workerId: "dead", at: 7 });
    expect(repo.recoverInterruptedIntegrations(db, 8)).toEqual(["q"]);
    expect(repo.getQueueEntry(db, "q")).toMatchObject({ state: "queued", worker_id: null,
      started_at: null, error: "Recovered after interrupted worker" });
    expect(repo.getLineageState(db, "lineage").audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "integration_recovered" })]));
    const reclaimed = repo.claimNext(db, { repositoryPath: "/repo",
      targetRef: "refs/heads/integration/lineage", workerId: "new", at: 9 });
    expect(reclaimed!.fencing_token).toBeGreaterThan(stale!.fencing_token);
    expect(() => repo.finishIntegration(db, { queueId: "q", workerId: "dead",
      fencingToken: stale!.fencing_token, outcome: "failed", at: 10 })).toThrow(/fence/);
    expect(repo.finishIntegration(db, { queueId: "q", workerId: "new",
      fencingToken: reclaimed!.fencing_token, outcome: "failed", at: 11 }).state).toBe("failed");
  });

  it("separates contribution review from final approval and gates promotion", () => {
    lineage(); const approved = ready(); repo.enqueueContribution(db, { id: "q", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue", at: 6 });
    const running = repo.claimNext(db, { repositoryPath: "/repo", targetRef: "refs/heads/integration/lineage",
      workerId: "worker", at: 7 });
    repo.finishIntegration(db, { queueId: "q", workerId: "worker", fencingToken: running!.fencing_token,
      outcome: "succeeded", resultSha: "integrated-head", at: 8 });
    const current = repo.getLineage(db, "lineage")!;
    expect(() => repo.enqueueLineage(db, { id: "promotion", lineageId: "lineage",
      idempotencyKey: "promote", expectedTargetSha: "target-at-enqueue", at: 9 })).toThrow(/approval/);
    repo.recordLineageGate(db, { id: "gate", lineageId: "lineage", name: "tests", status: "passed", at: 9 });
    repo.recordLineageApproval(db, { id: "final-review", lineageId: "lineage",
      expectedRevision: current.revision + 1, decision: "approved", actor: "owner", at: 10 });
    expect(repo.enqueueLineage(db, { id: "promotion", lineageId: "lineage",
      idempotencyKey: "promote", expectedTargetSha: "target-at-enqueue", at: 11 })).toMatchObject({ kind: "lineage",
        target_ref: "refs/heads/main", expected_target_sha: "target-at-enqueue", state: "queued" });
  });

  it("persists final-target conflict and requires resolution, gates, and a head-frozen re-review", () => {
    lineage(); const approved = ready(); repo.enqueueContribution(db, { id: "q", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue", at: 6 });
    const integrating = repo.claimNext(db, { repositoryPath: "/repo",
      targetRef: "refs/heads/integration/lineage", workerId: "worker", at: 7 })!;
    repo.finishIntegration(db, { queueId: "q", workerId: "worker", fencingToken: integrating.fencing_token,
      outcome: "succeeded", resultSha: "integrated-head", at: 8 });
    repo.recordLineageGate(db, { id: "gate", lineageId: "lineage", name: "tests", status: "passed", at: 9 });
    let current = repo.getLineage(db, "lineage")!;
    repo.recordLineageApproval(db, { id: "approval", lineageId: "lineage",
      expectedRevision: current.revision, decision: "approved", actor: "owner", at: 10 });
    repo.enqueueLineage(db, { id: "promotion", lineageId: "lineage", idempotencyKey: "promote",
      expectedTargetSha: "target-at-enqueue", at: 11 });
    const promotion = repo.claimNext(db, { repositoryPath: "/repo", targetRef: "refs/heads/main",
      workerId: "promoter", at: 12 })!;
    repo.finishIntegration(db, { queueId: promotion.id, workerId: "promoter",
      fencingToken: promotion.fencing_token, outcome: "conflicted", error: "target moved", at: 13 });
    current = repo.getLineage(db, "lineage")!; expect(current.integration_state).toBe("conflicted");
    const resolved = resolveLineagePromotionConflict(db, { lineageId: "lineage",
      expectedRevision: current.revision, integrationHeadSha: "resolved-head", actor: "owner",
      reason: "resolved target conflict", at: 14 });
    expect(() => repo.retryIntegration(db, { priorQueueId: promotion.id, id: "retry",
      idempotencyKey: "retry", expectedTargetSha: "target-at-retry", at: 15 })).toThrow(/approval|gates/);
    repo.recordLineageGate(db, { id: "gate-2", lineageId: "lineage", name: "tests", status: "passed", at: 16 });
    current = repo.getLineage(db, "lineage")!;
    repo.recordLineageApproval(db, { id: "approval-2", lineageId: "lineage",
      expectedRevision: current.revision, decision: "approved", actor: "owner", at: 17 });
    expect(repo.retryIntegration(db, { priorQueueId: promotion.id, id: "retry",
      idempotencyKey: "retry", expectedTargetSha: "target-at-retry", at: 18 }))
      .toMatchObject({ state: "queued", attempt: 2, expected_target_sha: "target-at-retry" });
    expect(resolved.integration_worktree_path).toBe("/repo/.wt/integration");
  });

  it("requires reachability before cleanup", () => {
    lineage(); const approved = ready(); repo.enqueueContribution(db, { id: "q", lineageId: "lineage",
      contributionId: approved.id, idempotencyKey: "enqueue", at: 6 });
    const running = repo.claimNext(db, { repositoryPath: "/repo", targetRef: "refs/heads/integration/lineage",
      workerId: "worker", at: 7 });
    repo.finishIntegration(db, { queueId: "q", workerId: "worker", fencingToken: running!.fencing_token,
      outcome: "succeeded", resultSha: "head", at: 8 });
    expect(() => repo.markContributionCleaned(db, { contributionId: approved.id,
      integrationQueueId: "q", workerId: "worker", fencingToken: running!.fencing_token,
      headReachable: false, at: 9 })).toThrow(/not reachable/);
    expect(repo.markContributionCleaned(db, { contributionId: approved.id,
      integrationQueueId: "q", workerId: "worker", fencingToken: running!.fencing_token,
      headReachable: true, at: 10 }).cleanup_state).toBe("cleaned");
  });

  it("replays every durable command after a lost response and rejects request mismatch", () => {
    let executions = 0;
    const first = executeIntegrationCommand(db, { requestId: "request", command: "create_lineage",
      payload: { id: "lineage", target: "main" }, at: 1 }, () => { executions += 1; return { id: "lineage" }; });
    const replay = executeIntegrationCommand(db, { requestId: "request", command: "create_lineage",
      payload: { target: "main", id: "lineage" }, at: 2 }, () => { executions += 1; return { id: "other" }; });
    expect(first.replayed).toBe(false); expect(replay).toEqual({ value: { id: "lineage" }, replayed: true });
    expect(executions).toBe(1);
    expect(() => executeIntegrationCommand(db, { requestId: "request", command: "discard",
      payload: { id: "lineage" }, at: 3 }, () => null)).toThrow(IntegrationIdempotencyMismatchError);
  });

  it("survives reopening a file database with schema and queue state intact", () => {
    db.close(); const file = path.join(os.tmpdir(), `integration-${crypto.randomUUID()}.db`); files.push(file);
    db = initDb(file); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db);
    createWorkItem(db, { id: "work", projectId: "project", projectPath: "/repo", title: "Task",
      changeMode: "worktree", at: 1 }); lineage(); contribution(); db.close();
    db = initDb(file); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db);
    expect(repo.getLineage(db, "lineage")?.integration_ref).toBe("refs/heads/integration/lineage");
    expect(repo.getContribution(db, "contribution")?.branch_name).toBe("refs/heads/work/run-1");
  });
});
