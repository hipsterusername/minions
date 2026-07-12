import { describe, expect, it, vi } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";
import { createWorkItem } from "./work-item-repo.ts";
import { findContributionByRun, getLineageState } from "./worktree-integration-repo.ts";
import { SqliteWorktreeIntegrationService } from "./worktree-integration-sqlite.ts";
import type { MergeGateVerdict } from "./system-model/gates.ts";

function setup(gates: () => Promise<MergeGateVerdict> = async () =>
  ({ allowed: true, mode: "off", gates: [] })) {
  const db = initDb(":memory:"); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db);
  createWorkItem(db, { id: "work", projectId: "project", projectPath: "/repo", title: "Task",
    changeMode: "worktree", workflowRank: "a", at: 1 });
  let tick = 10; const service = new SqliteWorktreeIntegrationService(db, () => tick++,
    async () => ({ targetRef: "refs/heads/main", baseSha: "abc123" }),
    async () => "head456", undefined, gates);
  return { db, service };
}

describe("SQLite worktree integration runtime", () => {
  it("persists a planned contribution and returns its exact worker identity before launch", async () => {
    const { db, service } = setup(); const plan = await service.bindRun({ workItemId: "work", runKey: "run-1" });
    expect(plan).toMatchObject({ projectPath: "/repo", leaderSessionKey: "run-1",
      branch: expect.stringContaining("minions/contribution/"), path: expect.stringContaining(".canvas-worktrees") });
    const contribution = findContributionByRun(db, "run-1")!;
    expect(contribution).toMatchObject({ state: "planned", branch_name: plan.branch, worktree_path: plan.path });
    expect(getLineageState(db, contribution.lineage_id).lineage).toMatchObject({ project_id: "project",
      target_ref: "refs/heads/main", base_sha: "abc123" }); db.close();
  });

  it("reuses the preserved conflicted contribution for a resolution iteration", async () => {
    const { db, service } = setup(); await service.bindRun({ workItemId: "work", runKey: "run-1" });
    const prior = findContributionByRun(db, "run-1")!;
    db.prepare("UPDATE worktree_contributions SET state='conflicted' WHERE id=?").run(prior.id);
    const plan = await service.bindRun({ workItemId: "work", runKey: "run-resolution" });
    expect(plan.path).toBe(prior.worktree_path); expect(plan.branch).toBe(prior.branch_name);
    expect(findContributionByRun(db, "run-resolution")?.id).toBe(prior.id); db.close();
  });

  it("adopts a legacy active worktree in place on the first bound interaction", async () => {
    const { db, service } = setup();
    db.prepare(`INSERT INTO sessions (session_key,project_id,status,cwd,role,work_item_id,
      run_number,run_kind,started_at,run_outcome,
      worktree_isolation,worktree_path,worktree_branch,worktree_project_path,worktree_created_at)
      VALUES ('legacy','project','idle','/repo/.canvas-worktrees/legacy','leader','work',1,
      'primary',1,'none',1,'/repo/.canvas-worktrees/legacy','canvas/legacy','/repo',2)`).run();
    await service.bindRun({ workItemId: "work", runKey: "run-next" });
    expect(findContributionByRun(db, "legacy")).toMatchObject({ worktree_path: "/repo/.canvas-worktrees/legacy",
      branch_name: "canvas/legacy", state: "active" }); db.close();
  });

  it("collects terminal changes into an immutable review head before queueing", async () => {
    const { db, service } = setup(); await service.bindRun({ workItemId: "work", runKey: "run-1" });
    service.transitionProvisioning("run-1", "active"); await service.collectRun("run-1", "completed");
    const ready = findContributionByRun(db, "run-1")!;
    expect(ready).toMatchObject({ state: "ready", head_sha: "head456", review_state: "pending" });
    const reviewed = await service.reviewContribution({ requestId: "review-1", contributionId: ready.id,
      expectedRevision: ready.revision, decision: "approved", actor: "user", summary: "looks good" });
    const approved = reviewed.contributions.find((entry) => entry.id === ready.id)!;
    const queued = await service.enqueueContribution({ requestId: "queue-1", contributionId: ready.id,
      expectedRevision: approved.revision });
    expect(queued.contributions.find((entry) => entry.id === ready.id)?.state).toBe("queued");
    expect(queued.queue).toContainEqual(expect.objectContaining({ kind: "contribution", state: "queued" }));
    db.close();
  });

  it("durably preserves a failed planned contribution for recovery", async () => {
    const { db, service } = setup(); await service.bindRun({ workItemId: "work", runKey: "run-fail" });
    service.transitionProvisioning("run-fail", "provisioning");
    expect(findContributionByRun(db, "run-fail")).toMatchObject({ state: "provisioning", revision: 1 });
    service.transitionProvisioning("run-fail", "failed", "git worktree add failed");
    expect(findContributionByRun(db, "run-fail")).toMatchObject({ state: "failed", revision: 2 });
    db.close();
  });

  it("keeps the same contribution path and branch across normal user iterations", async () => {
    const { db, service } = setup(); const first = await service.bindRun({ workItemId: "work", runKey: "run-1" });
    service.transitionProvisioning("run-1", "active"); await service.collectRun("run-1", "completed");
    const second = await service.bindRun({ workItemId: "work", runKey: "run-2" });
    expect(second).toMatchObject({ path: first.path, branch: first.branch });
    const reused = findContributionByRun(db, "run-2")!;
    expect(reused.id).toBe(findContributionByRun(db, "run-1")!.id);
    expect(reused).toMatchObject({ state: "active", review_state: "pending", head_sha: "head456" });
    db.close();
  });

  it("reuses the retained integration worktree for final-lineage conflict resolution", async () => {
    const { db, service } = setup(); await service.bindRun({ workItemId: "work", runKey: "run-1" });
    const contribution = findContributionByRun(db, "run-1")!;
    db.prepare(`UPDATE worktree_lineages SET integration_state='conflicted',revision=revision+1
      WHERE id=?`).run(contribution.lineage_id);
    const lineage = getLineageState(db, contribution.lineage_id).lineage!;
    const plan = await service.bindRun({ workItemId: "work", runKey: "resolve-lineage" });
    const replay = await service.bindRun({ workItemId: "work", runKey: "resolve-lineage" });
    expect(replay).toEqual(plan);
    expect(plan).toMatchObject({ path: lineage.integration_worktree_path,
      branch: lineage.integration_ref.replace("refs/heads/", "") });
    await service.collectRun("resolve-lineage", "completed");
    expect(getLineageState(db, lineage.id).lineage).toMatchObject({
      integration_state: "active", integration_head_sha: "head456" });
    db.close();
  });

  it("recovers an error-sealed lineage resolution as failed after restart", async () => {
    const { db, service } = setup(); await service.bindRun({ workItemId: "work", runKey: "run-1" });
    const contribution = findContributionByRun(db, "run-1")!;
    db.prepare("UPDATE worktree_lineages SET integration_state='conflicted',revision=revision+1 WHERE id=?")
      .run(contribution.lineage_id);
    await service.bindRun({ workItemId: "work", runKey: "resolve-error" });
    db.prepare(`INSERT INTO sessions (session_key,project_id,status,cwd,role,work_item_id,
      run_number,run_kind,started_at,ended_at,run_outcome)
      VALUES ('resolve-error','project','idle','/repo','leader','work',1,'primary',1,2,'error')`).run();
    await expect(service.recoverTerminalContributions()).resolves.toContain("resolve-error");
    expect(getLineageState(db, contribution.lineage_id).resolutionRuns).toContainEqual(
      expect.objectContaining({ run_key: "resolve-error", state: "failed" })); db.close();
  });

  it("persists worker-owned failing gates and returns a stable gate error", async () => {
    const { db, service } = setup(async () => ({ allowed: false, mode: "enforced" as const,
      gates: [{ id: "tests", name: "Tests", status: "failed" as const, reason: "tests failed" }] }));
    await service.bindRun({ workItemId: "work", runKey: "run-1" });
    service.transitionProvisioning("run-1", "active"); await service.collectRun("run-1", "completed");
    const ready = findContributionByRun(db, "run-1")!;
    await expect(service.reviewContribution({ requestId: "blocked-review", contributionId: ready.id,
      expectedRevision: ready.revision, decision: "approved", actor: "user", summary: "approve" }))
      .rejects.toMatchObject({ code: "gate_failed", latest: expect.any(Object) });
    expect(getLineageState(db, ready.lineage_id).gates).toContainEqual(expect.objectContaining({
      contribution_id: ready.id, name: "tests", status: "failed" })); db.close();
  });

  it("records advisory failures without blocking review or queue", async () => {
    const { db, service } = setup(async () => ({ allowed: false, mode: "advisory" as const,
      gates: [{ id: "tests", name: "Tests", status: "failed" as const, reason: "tests failed" }] }));
    await service.bindRun({ workItemId: "work", runKey: "run-1" });
    service.transitionProvisioning("run-1", "active"); await service.collectRun("run-1", "completed");
    const ready = findContributionByRun(db, "run-1")!;
    const reviewed = await service.reviewContribution({ requestId: "advisory-review", contributionId: ready.id,
      expectedRevision: ready.revision, decision: "approved", actor: "user", summary: "approve" });
    const approved = reviewed.contributions.find((entry) => entry.id === ready.id)!;
    await expect(service.enqueueContribution({ requestId: "advisory-queue", contributionId: ready.id,
      expectedRevision: approved.revision })).resolves.toMatchObject({ queue: [expect.objectContaining({ state: "queued" })] });
    expect(getLineageState(db, ready.lineage_id).gates).toContainEqual(expect.objectContaining({
      name: "tests", status: "waived", details: expect.stringContaining("advisoryStatus") })); db.close();
  });

  it("translates a stale real mutation to conflict with the latest lineage", async () => {
    const { db, service } = setup(); await service.bindRun({ workItemId: "work", runKey: "run-1" });
    const row = findContributionByRun(db, "run-1")!;
    await expect(service.discardContribution({ requestId: "stale-discard", contributionId: row.id,
      expectedRevision: 99, reason: "stale" })).rejects.toMatchObject({
        code: "conflict", latest: expect.objectContaining({ id: row.lineage_id }) }); db.close();
  });

  it("binds and orders two work items in one shared lineage", async () => {
    const { db, service } = setup(); createWorkItem(db, { id: "work-2", projectId: "project",
      projectPath: "/repo", title: "Second", changeMode: "worktree", workflowRank: "b", at: 2 });
    const created = await service.createLineage({ requestId: "shared", workItemId: "work" });
    const joined = await service.joinLineage({ requestId: "join-second", workItemId: "work-2",
      lineageId: created.id, expectedRevision: created.revision, actor: "user" });
    const [one, two] = await Promise.all([service.bindRun({ workItemId: "work", runKey: "run-1" }),
      service.bindRun({ workItemId: "work-2", runKey: "run-2" })]);
    expect(one.path).not.toBe(two.path); expect(one.branch).not.toBe(two.branch);
    expect(joined.memberships.map((entry) => entry.workItemId)).toEqual(["work", "work-2"]);
    for (const runKey of ["run-1", "run-2"]) {
      service.transitionProvisioning(runKey, "active"); await service.collectRun(runKey, "completed");
      const contribution = findContributionByRun(db, runKey)!;
      const reviewed = await service.reviewContribution({ requestId: `review-${runKey}`,
        contributionId: contribution.id, expectedRevision: contribution.revision,
        decision: "approved", actor: "user", summary: "approved" });
      const current = reviewed.contributions.find((entry) => entry.id === contribution.id)!;
      await service.enqueueContribution({ requestId: `queue-${runKey}`, contributionId: contribution.id,
        expectedRevision: current.revision });
    }
    const final = await service.getStatus({ lineageId: created.id });
    expect(final?.contributions).toHaveLength(2);
    expect(final?.queue.map((entry) => entry.position)).toEqual([1, 2]); db.close();
  });

  it("isolates publication failures after a committed command", async () => {
    const { service } = setup(); service.setWorkItemNotifier(() => { throw new Error("observer failed"); });
    await expect(service.createLineage({ requestId: "observer-safe", workItemId: "work" }))
      .resolves.toMatchObject({ memberships: [expect.objectContaining({ workItemId: "work" })] });
  });

  it("notifies canonical work-item consumers after commit", async () => {
    const { service } = setup(); const notified = vi.fn(); service.setWorkItemNotifier(notified);
    await service.createLineage({ requestId: "notify", workItemId: "work" });
    expect(notified).toHaveBeenCalledWith("work", "create_lineage");
  });

  it.each(["passed", "failed"] as const)("aggregates two contribution gates for final review: %s", async (secondStatus) => {
    const { db, service } = setup(async () => ({ allowed: false, mode: "enforced" as const,
      gates: [{ id: "tests", name: "Tests", status: "required_pending" as const, reason: "combined diff" }] }));
    createWorkItem(db, { id: "work-2", projectId: "project", projectPath: "/repo", title: "Second",
      changeMode: "worktree", workflowRank: "b", at: 2 });
    const created = await service.createLineage({ requestId: "aggregate", workItemId: "work" });
    await service.joinLineage({ requestId: "aggregate-join", workItemId: "work-2", lineageId: created.id,
      expectedRevision: created.revision, actor: "user" });
    await service.bindRun({ workItemId: "work", runKey: "run-1" });
    await service.bindRun({ workItemId: "work-2", runKey: "run-2" });
    const contributions = getLineageState(db, created.id).contributions;
    for (const [index, contribution] of contributions.entries()) {
      db.prepare("UPDATE worktree_contributions SET state='integrated',head_sha=? WHERE id=?")
        .run(`head-${index}`, contribution.id);
      const current = findContributionByRun(db, contribution.originating_run_key)!;
      const { recordGate } = await import("./worktree-integration-repo.ts");
      recordGate(db, { id: `gate-${index}`, contributionId: current.id, name: "tests",
        status: index === 1 ? secondStatus : "passed", at: 30 + index });
    }
    const lineage = getLineageState(db, created.id).lineage!;
    db.prepare("UPDATE worktree_lineages SET integration_head_sha='combined' WHERE id=?").run(lineage.id);
    const input = { requestId: `final-${secondStatus}`, lineageId: lineage.id,
      expectedRevision: lineage.revision, decision: "approved" as const, actor: "user", summary: "final" };
    if (secondStatus === "passed") await expect(service.reviewFinal(input)).resolves.toMatchObject({
      reviews: expect.arrayContaining([expect.objectContaining({ scope: "lineage", decision: "approved" })]) });
    else await expect(service.reviewFinal(input)).rejects.toMatchObject({ code: "gate_failed" });
    db.close();
  });

  it("does not treat an advisory waiver as satisfied after mode changes to enforced", async () => {
    let mode: "advisory" | "enforced" = "advisory";
    const { db, service } = setup(async () => ({ allowed: false, mode,
      gates: [{ id: "tests", name: "Tests", status: "failed" as const, reason: "failed" }] }));
    await service.bindRun({ workItemId: "work", runKey: "run-1" });
    service.transitionProvisioning("run-1", "active"); await service.collectRun("run-1", "completed");
    let row = findContributionByRun(db, "run-1")!;
    await service.reviewContribution({ requestId: "advisory", contributionId: row.id,
      expectedRevision: row.revision, decision: "approved", actor: "user", summary: "approved" });
    db.prepare("UPDATE worktree_contributions SET state='integrated' WHERE id=?").run(row.id);
    const lineage = getLineageState(db, row.lineage_id).lineage!;
    db.prepare("UPDATE worktree_lineages SET integration_head_sha='combined' WHERE id=?").run(lineage.id);
    mode = "enforced"; const current = getLineageState(db, lineage.id).lineage!;
    await expect(service.reviewFinal({ requestId: "enforced", lineageId: lineage.id,
      expectedRevision: current.revision, decision: "approved", actor: "user", summary: "final" }))
      .rejects.toMatchObject({ code: "gate_failed" }); db.close();
  });

  it("returns terminal lineage history for reconnect after membership retirement", async () => {
    const { db, service } = setup(); const lineage = await service.createLineage({ requestId: "terminal", workItemId: "work" });
    db.prepare("UPDATE worktree_lineages SET status='integrated',integration_state='integrated' WHERE id=?").run(lineage.id);
    db.prepare("UPDATE worktree_lineage_memberships SET status='left',left_at=20 WHERE lineage_id=?").run(lineage.id);
    await expect(service.getStatus({ workItemId: "work" })).resolves.toMatchObject({ id: lineage.id,
      status: "integrated", memberships: [expect.objectContaining({ status: "left" })] }); db.close();
  });
});
