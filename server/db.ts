import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH =
  process.env["DB_PATH"] ??
  path.join(process.cwd(), "data", "canvas.db");

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env["DB_PATH"] ?? path.join(process.cwd(), "data", "canvas.db");
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      transform_x     REAL NOT NULL DEFAULT 0,
      transform_y     REAL NOT NULL DEFAULT 0,
      transform_scale REAL NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id          TEXT NOT NULL,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      pos_x       REAL NOT NULL DEFAULT 0,
      pos_y       REAL NOT NULL DEFAULT 0,
      width       REAL NOT NULL DEFAULT 240,
      height      REAL NOT NULL DEFAULT 180,
      data        TEXT NOT NULL DEFAULT '{}',
      z_index     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);

    CREATE TABLE IF NOT EXISTS edges (
      id              TEXT NOT NULL,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_node_id  TEXT NOT NULL,
      source_port_id  TEXT NOT NULL,
      target_node_id  TEXT NOT NULL,
      target_port_id  TEXT NOT NULL,
      protocol        TEXT NOT NULL,
      z_index         INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);

    CREATE TABLE IF NOT EXISTS sessions (
      session_key   TEXT PRIMARY KEY,
      project_id    TEXT,
      node_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'idle',
      cwd           TEXT,
      model         TEXT,
      role          TEXT NOT NULL DEFAULT 'default',
      task_name     TEXT,
      session_id    TEXT,
      worktree_isolation INTEGER NOT NULL DEFAULT 0,
      worktree_path TEXT,
      worktree_branch TEXT,
      worktree_project_path TEXT,
      worktree_created_at INTEGER,
      worktree_lifecycle TEXT,
      approval_json TEXT,
      total_cost    REAL NOT NULL DEFAULT 0,
      turns         INTEGER NOT NULL DEFAULT 0,
      harness_name  TEXT NOT NULL DEFAULT 'claude',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_records (
      task_id            TEXT PRIMARY KEY,
      leader_session_key TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      priority           TEXT NOT NULL DEFAULT 'medium',
      executor           TEXT NOT NULL DEFAULT 'leader',
      minion_session_key TEXT,
      status             TEXT NOT NULL DEFAULT 'planned',
      result             TEXT,
      created_at         INTEGER NOT NULL,
      completed_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_records_leader ON task_records(leader_session_key);

    CREATE TABLE IF NOT EXISTS render_state (
      session_key   TEXT PRIMARY KEY,
      title         TEXT NOT NULL DEFAULT '',
      columns       INTEGER NOT NULL DEFAULT 2,
      gap           INTEGER NOT NULL DEFAULT 12,
      components    TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS reasoning_map_state (
      session_key   TEXT PRIMARY KEY,
      state_json    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key    TEXT NOT NULL,
      event_type     TEXT NOT NULL,
      payload        TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 2,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_key);

    CREATE TABLE IF NOT EXISTS routine_runs (
      run_id        TEXT PRIMARY KEY,
      routine_id    TEXT NOT NULL,
      project_path  TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      state         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_runs_project
      ON routine_runs(project_path, started_at DESC);
  `);

  // Idempotent migration: older databases were created before `session_id`
  // existed on the `sessions` table. Without this column the SDK
  // session_id is lost across restarts, and `send_message` cannot resume —
  // it starts a brand-new conversation with no transcript.
  ensureColumn(db, "sessions", "session_id", "TEXT");
  ensureColumn(db, "sessions", "worktree_path", "TEXT");
  ensureColumn(db, "sessions", "worktree_branch", "TEXT");
  ensureColumn(db, "sessions", "worktree_project_path", "TEXT");
  ensureColumn(db, "sessions", "worktree_created_at", "INTEGER");
  ensureColumn(db, "sessions", "worktree_lifecycle", "TEXT");
  ensureColumn(db, "sessions", "approval_json", "TEXT");

  // Phase B (codex-harness-spec) migration: persist the harness name so
  // restored sessions resume on the same harness they started on. Pre-migration
  // rows back-fill to "claude" via the column DEFAULT — exactly the behaviour
  // before this column existed.
  ensureColumn(db, "sessions", "harness_name", "TEXT NOT NULL DEFAULT 'claude'");

  // Phase 3 migration: add schema_version to event_log if the column was
  // added after the table was first created. Existing rows pre-date Phase 3
  // and carry raw SDK payloads (schema v1) — drop them so the client only
  // ever replays normalized events. event_log is a 5-minute replay buffer,
  // not durable history; row loss here is acceptable (spec §6.2).
  const hasSchemaVersion = (
    db.pragma("table_info(event_log)") as Array<{ name: string }>
  ).some((r) => r.name === "schema_version");
  if (!hasSchemaVersion) {
    db.exec("ALTER TABLE event_log ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1");
    db.exec("DELETE FROM event_log WHERE schema_version < 2");
  }

  return db;
}

/**
 * Add `column` of `type` to `table` if it doesn't already exist.
 * SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so we inspect
 * `PRAGMA table_info` first.
 */
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
