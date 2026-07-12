import { describe, expect, it } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { createWorkItem } from "./work-item-repo.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";

describe("worktree integration additive migration", () => {
  it("upgrades an earlier Phase4 shape idempotently", () => {
    const db = initDb(":memory:"); ensureWorkItemSchema(db);
    createWorkItem(db, { id: "work", projectId: "project", projectPath: "/repo",
      title: "Legacy", changeMode: "worktree", workflowRank: "a", at: 1 });
    db.exec(`
      CREATE TABLE worktree_lineages (id TEXT PRIMARY KEY,repository_path TEXT NOT NULL,
        target_ref TEXT NOT NULL,base_sha TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE worktree_contributions (id TEXT PRIMARY KEY,lineage_id TEXT NOT NULL,work_item_id TEXT NOT NULL,
        originating_run_key TEXT NOT NULL UNIQUE,branch_name TEXT NOT NULL UNIQUE,worktree_path TEXT NOT NULL UNIQUE,
        base_sha TEXT NOT NULL,head_sha TEXT,state TEXT NOT NULL,review_state TEXT NOT NULL,
        cleanup_state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE worktree_integration_queue (id TEXT PRIMARY KEY,lineage_id TEXT NOT NULL,contribution_id TEXT,
        kind TEXT NOT NULL,repository_path TEXT NOT NULL,target_ref TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,attempt INTEGER NOT NULL,worker_id TEXT,result_sha TEXT,error TEXT,enqueued_at INTEGER NOT NULL,
        started_at INTEGER,finished_at INTEGER,updated_at INTEGER NOT NULL);
      CREATE TABLE worktree_integration_reviews (id TEXT PRIMARY KEY,lineage_id TEXT NOT NULL,contribution_id TEXT,
        scope TEXT NOT NULL,decision TEXT NOT NULL,actor TEXT NOT NULL,notes TEXT,recorded_at INTEGER NOT NULL);
      CREATE TABLE worktree_integration_gates (id TEXT PRIMARY KEY,contribution_id TEXT NOT NULL,name TEXT NOT NULL,
        status TEXT NOT NULL,details TEXT,recorded_at INTEGER NOT NULL,UNIQUE(contribution_id,name));
      INSERT INTO worktree_lineages VALUES ('old','/repo','refs/heads/main','base','open',1,1);
      INSERT INTO worktree_contributions VALUES ('contribution','old','work','run','branch','/repo/.wt/run',
        'base',NULL,'active','pending','retained',1,1);
    `);
    ensureWorktreeIntegrationSchema(db); ensureWorktreeIntegrationSchema(db);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns("worktree_lineages")).toEqual(expect.arrayContaining([
      "project_id","integration_ref","integration_worktree_path","integration_head_sha","revision"]));
    expect(columns("worktree_integration_queue")).toEqual(expect.arrayContaining([
      "revision","fencing_token","expected_source_sha","expected_target_sha","conflict_details_json"]));
    expect(columns("worktree_integration_reviews")).toContain("reviewed_head_sha");
    expect(db.prepare("SELECT integration_ref FROM worktree_lineages WHERE id='old'").get())
      .toEqual({ integration_ref: "refs/heads/minions/integration/old" });
    expect(db.prepare("SELECT integration_worktree_path FROM worktree_lineages WHERE id='old'").get())
      .toEqual({ integration_worktree_path: "/repo/.canvas-worktrees/integration-old" });
    expect(db.prepare("SELECT project_id FROM worktree_lineages WHERE id='old'").get())
      .toEqual({ project_id: "project" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_lineage_memberships'").get())
      .toEqual({ name: "worktree_lineage_memberships" });
    expect(db.prepare(`SELECT lineage_id,work_item_id,status,actor
      FROM worktree_lineage_memberships`).get()).toEqual({
        lineage_id: "old", work_item_id: "work", status: "active", actor: "migration" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_lineage_resolution_runs'").get())
      .toEqual({ name: "worktree_lineage_resolution_runs" });
    db.close();
  });
});
