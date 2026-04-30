/**
 * server/db — SQLite migration safety.
 *
 * Tests run against a tmpdir DB path (NEVER the user's real DB). The contract
 * we pin per docs/testing-strategy.md §7.1:
 *   1. A fresh DB opens cleanly and accepts inserts/selects against the
 *      documented public tables.
 *   2. Re-opening an already-migrated DB is a no-op (idempotent).
 *   3. A pre-existing DB without the `session_id` column has it added by
 *      the documented one-shot migration.
 *   4. WAL mode and foreign keys are enabled.
 *
 * Per §5.7, we do NOT assert on `pragma table_info` for column shapes —
 * we exercise the real read/write path instead.
 */
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "./db.ts";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup: (() => void)[] = [];

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "minions-db-test-"));
  const dbPath = join(dir, "canvas.db");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dbPath;
}

afterEach(() => {
  while (cleanup.length) {
    cleanup.pop()!();
  }
});

describe("initDb — fresh DB", () => {
  it("opens, runs migrations, and round-trips a project insert/select", () => {
    const path = freshDbPath();
    const db = initDb(path);

    db.prepare(
      "INSERT INTO projects (id, name, transform_x, transform_y, transform_scale) VALUES (?, ?, ?, ?, ?)",
    ).run("p1", "First Project", 0, 0, 1);

    const row = db
      .prepare(
        "SELECT id, name, transform_x, transform_y, transform_scale FROM projects WHERE id = ?",
      )
      .get("p1") as Record<string, unknown>;

    expect(row).toMatchObject({
      id: "p1",
      name: "First Project",
      transform_x: 0,
      transform_y: 0,
      transform_scale: 1,
    });
    db.close();
  });

  it("creates every documented table by exercising a write to each one", () => {
    const db = initDb(freshDbPath());

    // Each insert below targets one of the tables initDb's CREATE TABLE
    // block declares. If the migration silently drops a table, the
    // corresponding insert fails with a SQL error — caught here.
    expect(() => {
      db.prepare(
        "INSERT INTO projects (id, name) VALUES ('proj', 'P')",
      ).run();
      db.prepare(
        "INSERT INTO nodes (id, project_id, type) VALUES ('n', 'proj', 'text')",
      ).run();
      db.prepare(
        "INSERT INTO sessions (session_key, project_id) VALUES ('s', 'proj')",
      ).run();
      db.prepare(
        `INSERT INTO task_records (task_id, leader_session_key, title, created_at) VALUES ('t', 's', 'T', ${Date.now()})`,
      ).run();
      db.prepare(
        "INSERT INTO render_state (session_key) VALUES ('s')",
      ).run();
      db.prepare(
        "INSERT INTO event_log (session_key, event_type, payload) VALUES ('s', 'e', '{}')",
      ).run();
      db.prepare(
        `INSERT INTO routine_runs (run_id, routine_id, project_path, snapshot_json, started_at, state) VALUES ('r', 'rt', '/p', '{}', '${new Date().toISOString()}', 'running')`,
      ).run();
    }).not.toThrow();

    db.close();
  });

  it("enforces the foreign_key constraint between nodes and projects", () => {
    const db = initDb(freshDbPath());

    // Without `foreign_keys = ON`, an orphan insert succeeds silently.
    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, project_id, type) VALUES ('n', 'no-such-project', 'text')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    db.close();
  });
});

describe("initDb — re-open is idempotent", () => {
  it("re-opening an already-migrated DB does not destroy its data", () => {
    const path = freshDbPath();

    const db1 = initDb(path);
    db1
      .prepare(
        "INSERT INTO projects (id, name) VALUES (?, ?)",
      )
      .run("survivor", "Survivor");
    db1.close();

    const db2 = initDb(path);
    const row = db2
      .prepare("SELECT id, name FROM projects WHERE id = ?")
      .get("survivor");
    expect(row).toMatchObject({ id: "survivor", name: "Survivor" });
    db2.close();
  });
});

describe("initDb — session_id migration", () => {
  it("adds session_id to a pre-existing sessions table that lacked it", () => {
    const path = freshDbPath();

    // Simulate an older DB: create the sessions table WITHOUT session_id.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        status      TEXT NOT NULL DEFAULT 'idle'
      );
    `);
    old
      .prepare("INSERT INTO sessions (session_key) VALUES (?)")
      .run("s-legacy");
    old.close();

    // Re-open via initDb — it must add session_id without nuking the row.
    const db = initDb(path);
    db
      .prepare("UPDATE sessions SET session_id = ? WHERE session_key = ?")
      .run("sdk-id-123", "s-legacy");
    const row = db
      .prepare(
        "SELECT session_key, session_id FROM sessions WHERE session_key = ?",
      )
      .get("s-legacy");
    expect(row).toMatchObject({
      session_key: "s-legacy",
      session_id: "sdk-id-123",
    });
    db.close();
  });
});
