import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createWorkItem, getWorkItem, startWorkItemIteration } from "./work-item-repo.ts";
import { attachWorkItemBinding } from "./work-item-binding-repo.ts";
import { auditAndRepairCanvasBindings } from "./work-item-repair.ts";
import { auditAndRepairContributionWorktrees } from "./work-item-repair.ts";
import { auditAndRepairRunningQueue, auditAndRepairUnsealedRuns } from "./work-item-repair.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";

describe("work-item repair tooling", () => {
  let db: Database.Database;
  beforeEach(() => { db = initDb(":memory:"); ensureWorkItemSchema(db); ensureWorktreeIntegrationSchema(db); });

  it("dry-runs, repairs only definitive orphans, and is idempotent", () => {
    createWorkItem(db, { id: "work-1", projectId: "project-1", projectPath: "/repo",
      title: "Task", changeMode: "live", workflowRank: "a", at: 1 });
    attachWorkItemBinding(db, { workItemId: "work-1", surface: "canvas",
      bindingId: "missing-node", at: 2 });
    db.prepare("UPDATE work_items SET kanban_json=? WHERE id='work-1'")
      .run(JSON.stringify({ leaderNodeId: "missing-node" }));
    const inspect = () => false;

    expect(auditAndRepairCanvasBindings({ db, inspect })).toEqual([expect.objectContaining({
      code: "orphan_canvas_binding", repaired: false,
    })]);
    expect(auditAndRepairCanvasBindings({ db, inspect, repair: true, at: 3 }))
      .toEqual([expect.objectContaining({ repaired: true })]);
    expect(auditAndRepairCanvasBindings({ db, inspect, repair: true, at: 4 })).toEqual([]);
    expect(JSON.parse(getWorkItem(db, "work-1")!.kanban_json).leaderNodeId).toBeNull();
  });

  it("reports an unavailable project without guessing or detaching", () => {
    createWorkItem(db, { id: "work-1", projectId: "project-1", projectPath: "/offline",
      title: "Task", changeMode: "live", workflowRank: "a", at: 1 });
    attachWorkItemBinding(db, { workItemId: "work-1", surface: "canvas", bindingId: "node", at: 2 });
    expect(auditAndRepairCanvasBindings({ db, inspect: () => null, repair: true }))
      .toEqual([expect.objectContaining({ code: "unverifiable_canvas_binding", repaired: false })]);
  });

  it("reports missing active paths and safely closes missing eligible cleanup records", () => {
    createWorkItem(db, { id: "work-1", projectId: "project-1", projectPath: "/repo",
      title: "Task", changeMode: "worktree", workflowRank: "a", at: 1 });
    db.prepare(`INSERT INTO worktree_lineages (id,project_id,repository_path,target_ref,base_sha,
      integration_ref,integration_worktree_path,created_at,updated_at)
      VALUES ('lineage','project-1','/repo','refs/heads/main','base','refs/heads/integration','/wt/i',1,1)`).run();
    for (const [id, cleanup] of [["active", "retained"], ["done", "eligible"]] as const)
      db.prepare(`INSERT INTO worktree_contributions (id,lineage_id,work_item_id,originating_run_key,
        branch_name,worktree_path,base_sha,state,cleanup_state,created_at,updated_at)
        VALUES (?,'lineage','work-1',?,?,?,'base',?, ?,1,1)`)
        .run(id, `run-${id}`, `branch-${id}`, `/wt/${id}`, id === "active" ? "active" : "integrated", cleanup);
    const inspectPath = () => "missing" as const;
    expect(auditAndRepairContributionWorktrees({ db, inspectPath, repair: true, at: 3 }))
      .toEqual([expect.objectContaining({ code: "missing_active_worktree", repaired: false }),
        expect.objectContaining({ code: "stale_eligible_worktree", repaired: true })]);
    expect(db.prepare("SELECT cleanup_state FROM worktree_contributions WHERE id='done'").get())
      .toEqual({ cleanup_state: "cleaned" });
  });

  it("dry-runs and seals orphaned canonical runs while preserving live runs", () => {
    for (const id of ["orphan", "live"]) {
      createWorkItem(db, { id, projectId: "project-1", projectPath: "/repo",
        title: id, changeMode: "live", workflowRank: id, at: 1 });
      startWorkItemIteration(db, { workItemId: id, runKey: `run-${id}`,
        idempotencyKey: `start-${id}`, expectedLifecycleRevision: 0,
        expectedCurrentRunKey: null, at: 2 });
    }
    const liveRunKeys = new Set(["run-live"]);
    expect(auditAndRepairUnsealedRuns({ db, liveRunKeys })).toEqual([
      expect.objectContaining({ runKey: "run-orphan", repaired: false }),
    ]);
    expect(auditAndRepairUnsealedRuns({ db, liveRunKeys, repair: true, at: 3 })).toEqual([
      expect.objectContaining({ runKey: "run-orphan", repaired: true }),
    ]);
    expect(db.prepare("SELECT run_outcome FROM sessions WHERE session_key='run-orphan'").get())
      .toEqual({ run_outcome: "interrupted" });
    expect(db.prepare("SELECT ended_at FROM sessions WHERE session_key='run-live'").get())
      .toEqual({ ended_at: null });
  });

  it("dry-runs and requeues integration work left running across restart", () => {
    db.prepare(`INSERT INTO worktree_lineages (id,project_id,repository_path,target_ref,base_sha,
      integration_ref,integration_worktree_path,created_at,updated_at)
      VALUES ('lineage','project-1','/repo','refs/heads/main','base','refs/heads/integration','/wt/i',1,1)`).run();
    db.prepare(`INSERT INTO worktree_integration_queue (id,lineage_id,kind,repository_path,target_ref,
      idempotency_key,expected_source_sha,expected_target_sha,state,worker_id,fencing_token,enqueued_at,started_at,updated_at)
      VALUES ('queue','lineage','lineage','/repo','refs/heads/main','key','source','target',
      'running','worker',1,1,2,2)`).run();
    expect(auditAndRepairRunningQueue({ db })).toEqual([
      { code: "stale_running_queue", queueId: "queue", lineageId: "lineage", repaired: false },
    ]);
    expect(auditAndRepairRunningQueue({ db, repair: true, at: 3 })[0]?.repaired).toBe(true);
    expect(db.prepare("SELECT state,worker_id FROM worktree_integration_queue WHERE id='queue'").get())
      .toEqual({ state: "queued", worker_id: null });
  });
});
