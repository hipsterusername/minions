import Database from "better-sqlite3";
import {describe,expect,it} from "vitest";
import {migrateTaskGraph} from "./schema.ts";

describe("task graph schema migration",()=>{
  it("replaces one-graph-ever uniqueness with one nonterminal graph and preserves history",()=>{
    const db=legacyGraphDatabase();

    migrateTaskGraph(db);

    const table=db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='task_graph_runs'`).get() as {sql:string};
    expect(table.sql).not.toMatch(/UNIQUE\s*\(\s*work_item_id\s*,\s*primary_run_key\s*\)/i);
    expect(db.prepare(`SELECT sql FROM sqlite_master WHERE type='index'
      AND name='task_one_nonterminal_graph_run'`).get()).toMatchObject({
      sql:expect.stringContaining("status NOT IN ('completed','failed','cancelled')"),
    });
    expect(db.prepare("SELECT run_id,node_id FROM task_node_attempts").all())
      .toEqual([{run_id:"graph-1",node_id:"node-1"}]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    insertRun(db,"graph-2","completed","source-2",2);
    insertRun(db,"graph-active","active","source-active",3);
    expect(()=>insertRun(db,"graph-conflict","active","source-conflict",4)).toThrow();
    expect(db.prepare("SELECT id,status FROM task_graph_runs ORDER BY created_at").all())
      .toEqual([
        {id:"graph-1",status:"completed"},
        {id:"graph-2",status:"completed"},
        {id:"graph-active",status:"active"},
      ]);

    migrateTaskGraph(db);
    expect(db.prepare("SELECT count(*) count FROM task_graph_runs").get()).toEqual({count:3});
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

function legacyGraphDatabase():Database.Database {
  const db=new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(`
    CREATE TABLE task_graph_definitions (
      id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE task_graph_revisions (
      id TEXT PRIMARY KEY,definition_id TEXT NOT NULL REFERENCES task_graph_definitions(id),
      spec_json TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE TABLE task_source_snapshots (
      id TEXT PRIMARY KEY,run_key TEXT NOT NULL,revision_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE TABLE task_graph_runs (
      id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,primary_run_key TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES task_graph_revisions(id),source_snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
      max_active_attempts INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(work_item_id,primary_run_key)
    );
    CREATE TABLE task_node_attempts (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES task_graph_runs(id),node_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,generation INTEGER NOT NULL,source_snapshot_id TEXT NOT NULL,
      runtime TEXT NOT NULL,outcome TEXT NOT NULL,session_run_key TEXT,progress_seq INTEGER NOT NULL DEFAULT 0,
      backoff_until INTEGER,terminal_witness_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(run_id,node_id,attempt_number),UNIQUE(run_id,node_id,generation)
    );
  `);
  db.prepare("INSERT INTO task_graph_definitions VALUES('definition','work','workspace',1)").run();
  db.prepare("INSERT INTO task_graph_revisions VALUES('revision','definition','{}','hash',1)").run();
  insertRun(db,"graph-1","completed","source-1",1);
  db.prepare(`INSERT INTO task_node_attempts
    (id,run_id,node_id,attempt_number,generation,source_snapshot_id,runtime,outcome,
      progress_seq,created_at,updated_at)
    VALUES('attempt-1','graph-1','node-1',1,1,'source-1','terminal','succeeded',0,1,1)`).run();
  return db;
}

function insertRun(db:Database.Database,id:string,status:string,sourceId:string,at:number):void {
  db.prepare("INSERT OR IGNORE INTO task_source_snapshots VALUES(?, 'primary', 'revision', '{}', ?, ?)")
    .run(sourceId,`hash-${sourceId}`,at);
  db.prepare(`INSERT INTO task_graph_runs
    (id,work_item_id,primary_run_key,revision_id,source_snapshot_id,status,paused,revision,
      max_active_attempts,created_at,updated_at)
    VALUES(?,'work','primary','revision',?,?,0,0,1,?,?)`).run(id,sourceId,status,at,at);
}
