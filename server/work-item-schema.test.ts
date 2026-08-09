import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

describe("global work-item schema migration", () => {
  it("is opt-in so project sidecars do not receive canonical global tables", () => {
    const sidecar = initDb(":memory:");
    expect(sidecar.prepare(`SELECT name FROM sqlite_master WHERE name = 'work_items'`).get())
      .toBeUndefined();
    sidecar.close();
  });

  it("installs tables, run columns, and indexes idempotently", () => {
    const db = initDb(":memory:");
    ensureWorkItemSchema(db);
    ensureWorkItemSchema(db);

    expect(columns(db, "work_items")).toEqual(expect.arrayContaining([
      "id", "runtime_state", "outcome", "resolution", "change_mode",
      "integration_state", "wait_kind", "archived_from_resolution",
      "current_run_key", "lifecycle_revision",
    ]));
    expect(columns(db, "work_items")).not.toEqual(expect.arrayContaining([
      "workflow_column_id", "workflow_rank", "workflow_revision", "kanban_json",
    ]));
    expect(columns(db, "work_item_bindings")).toContain("detached_at");
    expect(columns(db, "sessions")).toEqual(expect.arrayContaining([
      "work_item_id", "run_number", "run_kind", "previous_run_key",
      "parent_run_key", "task_id", "started_at", "ended_at", "run_outcome",
      "final_report_event_id", "start_idempotency_key",
    ]));
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'
    `).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      "idx_sessions_work_item_run",
      "idx_sessions_work_item_start_idempotency",
      "idx_sessions_one_unsealed_primary",
      "idx_sessions_parent_task",
    ]));
    db.close();
  });

  it("migrates a populated legacy sessions table without reclassifying its rows", () => {
    const db = initDb(":memory:");
    db.prepare(`
      INSERT INTO sessions (session_key, status, cwd, role, created_at, updated_at)
      VALUES ('legacy-1', 'idle', '/repo', 'leader', 'old', 'old')
    `).run();
    ensureWorkItemSchema(db);
    const row = db.prepare(`
      SELECT work_item_id, run_kind, run_outcome, run_number FROM sessions WHERE session_key = 'legacy-1'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      work_item_id: null, run_kind: "primary", run_outcome: "none", run_number: null,
    });
    db.close();
  });

  it("enforces primary/child shape and unique child task identity", () => {
    const db = initDb(":memory:");
    ensureWorkItemSchema(db);
    db.prepare(`
      INSERT INTO work_items (
        id, project_id, project_path, title, runtime_state, outcome, resolution,
        change_mode, integration_state, last_transition_at, created_at, updated_at
      ) VALUES ('work-1', 'p', '/repo', 'T', 'working', 'none', 'open', 'live', 'live_clean', 1, 1, 1)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO sessions (session_key, work_item_id, run_kind, run_number, run_outcome)
      VALUES ('bad-child', 'work-1', 'child', 1, 'none')
    `).run()).toThrow("invalid work-item run shape");
    db.prepare(`
      INSERT INTO sessions (
        session_key, work_item_id, run_kind, run_number, parent_run_key, task_id,
        started_at, run_outcome
      ) VALUES ('child-1', 'work-1', 'child', NULL, 'parent-1', 'task-1', 1, 'none')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO sessions (
        session_key, work_item_id, run_kind, run_number, parent_run_key, task_id,
        started_at, run_outcome
      ) VALUES ('child-2', 'work-1', 'child', NULL, 'parent-1', 'task-1', 2, 'none')
    `).run()).toThrow();
    db.close();
  });

  it("allows only one active binding for a surface identity", () => {
    const db = initDb(":memory:");
    ensureWorkItemSchema(db);
    const insertItem = db.prepare(`
      INSERT INTO work_items (
        id, project_id, project_path, title, runtime_state, outcome, resolution,
        change_mode, integration_state, last_transition_at, created_at, updated_at
      ) VALUES (?, 'p', '/repo', 'T', 'draft', 'none', 'open', 'live', 'live_clean', 1, 1, 1)
    `);
    insertItem.run("work-1");
    insertItem.run("work-2");
    db.prepare(`INSERT INTO work_item_bindings VALUES ('work-1', 'canvas', 'node-1', 1, NULL)`).run();
    expect(() => db.prepare(`INSERT INTO work_item_bindings VALUES ('work-2', 'canvas', 'node-1', 2, NULL)`).run()).toThrow();
    db.prepare(`UPDATE work_item_bindings SET detached_at = 3 WHERE work_item_id = 'work-1'`).run();
    expect(() => db.prepare(`INSERT INTO work_item_bindings VALUES ('work-2', 'canvas', 'node-1', 4, NULL)`).run())
      .not.toThrow();
    db.close();
  });

  it("rebuilds the legacy run_outcome CHECK so stopped rows become valid and history is untouched", () => {
    const db = initDb(":memory:");
    ensureWorkItemSchema(db);
    // Downgrade the sessions table to the pre-`stopped` four-outcome CHECK to
    // simulate an existing database created before this migration shipped.
    const table = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'sessions'`).get() as { sql: string };
    const objects = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE tbl_name = 'sessions' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
      .all() as Array<{ name: string; sql: string }>;
    const cols = (db.pragma("table_info(sessions)") as Array<{ name: string }>)
      .map((row) => `"${row.name}"`).join(", ");
    db.pragma("foreign_keys = OFF");
    db.exec(table.sql
      .replace(/^CREATE TABLE\s+sessions/i, "CREATE TABLE sessions_downgrade")
      .replace("'none', 'completed', 'error', 'stopped', 'interrupted'",
        "'none', 'completed', 'error', 'interrupted'"));
    db.exec(`INSERT INTO sessions_downgrade (${cols}) SELECT ${cols} FROM sessions`);
    db.exec("DROP TABLE sessions");
    db.exec("ALTER TABLE sessions_downgrade RENAME TO sessions");
    for (const object of objects) {
      if (!object.name.startsWith("validate_work_item_run")) db.exec(object.sql);
    }
    db.pragma("foreign_keys = ON");

    db.prepare(`
      INSERT INTO sessions (session_key, status, cwd, role, created_at, updated_at, ended_at, run_outcome)
      VALUES ('historic-1', 'stopped', '/repo', 'leader', 'old', 'old', 5, 'interrupted')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO sessions (session_key, status, cwd, role, created_at, updated_at, ended_at, run_outcome)
      VALUES ('rejected', 'stopped', '/repo', 'leader', 'old', 'old', 6, 'stopped')
    `).run()).toThrow(); // proves the legacy CHECK is live before migration
    const before = db.prepare(`SELECT * FROM sessions WHERE session_key = 'historic-1'`).get();

    ensureWorkItemSchema(db);

    expect(db.prepare(`SELECT * FROM sessions WHERE session_key = 'historic-1'`).get())
      .toEqual(before);
    expect(() => db.prepare(`
      INSERT INTO sessions (session_key, status, cwd, role, created_at, updated_at, ended_at, run_outcome)
      VALUES ('stopped-1', 'stopped', '/repo', 'leader', 'now', 'now', 7, 'stopped')
    `).run()).not.toThrow();
    const restored = db.prepare(`SELECT name FROM sqlite_master
      WHERE tbl_name = 'sessions' AND type = 'index' AND sql IS NOT NULL`)
      .all() as Array<{ name: string }>;
    expect(restored.map((row) => row.name)).toEqual(expect.arrayContaining([
      "idx_sessions_work_item_run",
      "idx_sessions_one_unsealed_primary",
      "idx_sessions_parent_task",
    ]));
    db.close();
  });
});
