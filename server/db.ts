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
      context_mode    TEXT,
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

    CREATE TABLE IF NOT EXISTS session_usage (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key           TEXT NOT NULL,
      role                  TEXT NOT NULL,
      model                 TEXT,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL,
      source                TEXT NOT NULL DEFAULT 'assistant',
      message_id            TEXT,
      turn_id               TEXT,
      harness_session_id    TEXT,
      usage_identity        TEXT NOT NULL DEFAULT '',
      created_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_usage_session
      ON session_usage(session_key, created_at);

    CREATE TABLE IF NOT EXISTS task_records (
      task_id            TEXT NOT NULL,
      leader_session_key TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      priority           TEXT NOT NULL DEFAULT 'medium',
      executor           TEXT NOT NULL DEFAULT 'leader',
      minion_session_key TEXT,
      status             TEXT NOT NULL DEFAULT 'planned',
      result             TEXT,
      created_at         INTEGER NOT NULL,
      completed_at       INTEGER,
      PRIMARY KEY (leader_session_key, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_records_leader ON task_records(leader_session_key);

    CREATE TABLE IF NOT EXISTS render_state (
      session_key   TEXT PRIMARY KEY,
      title         TEXT NOT NULL DEFAULT '',
      columns       INTEGER NOT NULL DEFAULT 2,
      gap           INTEGER NOT NULL DEFAULT 12,
      components    TEXT NOT NULL DEFAULT '[]'
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

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_vapid (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      public_key  TEXT NOT NULL,
      private_key TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_packets (
      id                  TEXT PRIMARY KEY,
      leader_session_key  TEXT NOT NULL,
      status              TEXT NOT NULL,
      risk_level          TEXT NOT NULL,
      user_request        TEXT NOT NULL,
      packet_json         TEXT NOT NULL,
      context_pack        TEXT NOT NULL DEFAULT '',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_packets_session
      ON work_packets(leader_session_key);

    CREATE TABLE IF NOT EXISTS work_packet_verifications (
      work_packet_id  TEXT NOT NULL,
      kind            TEXT NOT NULL,
      target          TEXT NOT NULL,
      result          TEXT NOT NULL,
      notes           TEXT,
      recorded_at     INTEGER NOT NULL,
      PRIMARY KEY (work_packet_id, kind, target)
    );

    CREATE TABLE IF NOT EXISTS reconciliation_reports (
      id              TEXT PRIMARY KEY,
      work_packet_id  TEXT NOT NULL,
      report_json     TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_checkpoints (
      checkpoint_id     TEXT PRIMARY KEY,
      session_key       TEXT NOT NULL,
      source_session_id TEXT,
      target_session_id TEXT,
      trigger           TEXT NOT NULL,
      status            TEXT NOT NULL,
      checkpoint_json   TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      committed_at      INTEGER,
      failed_at         INTEGER,
      failure_reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_context_checkpoints_session
      ON context_checkpoints(session_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS system_model_usage (
      object_id       TEXT NOT NULL,
      work_packet_id  TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT 'packet',
      session_key     TEXT NOT NULL DEFAULT '',
      used_at         INTEGER NOT NULL,
      PRIMARY KEY (object_id, work_packet_id, source, session_key)
    );
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
  ensureColumn(db, "sessions", "review_state", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, "sessions", "review_reason", "TEXT");
  ensureColumn(db, "sessions", "final_report", "TEXT");
  ensureColumn(db, "sessions", "final_dashboard_revision", "INTEGER");
  ensureColumn(db, "sessions", "dashboard_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "terminal_reason", "TEXT");
  ensureColumn(db, "sessions", "terminal_at", "INTEGER");
  ensureColumn(db, "sessions", "acknowledged_at", "INTEGER");
  ensureColumn(db, "sessions", "dismissed_at", "INTEGER");
  ensureColumn(db, "sessions", "lifecycle_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_usage", "source", "TEXT NOT NULL DEFAULT 'assistant'");
  ensureColumn(db, "session_usage", "message_id", "TEXT");
  ensureColumn(db, "session_usage", "turn_id", "TEXT");
  ensureColumn(db, "session_usage", "harness_session_id", "TEXT");
  ensureColumn(db, "session_usage", "usage_identity", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "work_packets", "context_pack", "TEXT NOT NULL DEFAULT ''");
  // Per-edge context forwarding mode for leader→leader context edges
  // ("dashboard" | "lean" | "full"). NULL = default ("dashboard").
  ensureColumn(db, "edges", "context_mode", "TEXT");
  ensureSystemModelUsageSchema(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_usage_identity
      ON session_usage(
        session_key,
        COALESCE(harness_session_id, ''),
        source,
        usage_identity
      )
      WHERE usage_identity <> ''
  `);
  ensureTaskRecordsCompositePk(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_records_leader ON task_records(leader_session_key)");

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

function ensureTaskRecordsCompositePk(db: Database.Database): void {
  const rows = db.pragma("table_info(task_records)") as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
  const taskId = rows.find((r) => r.name === "task_id");
  const leader = rows.find((r) => r.name === "leader_session_key");
  if (taskId?.pk && leader?.pk) return;

  const collision = db
    .prepare(
      `SELECT leader_session_key, task_id, COUNT(*) AS count
       FROM task_records
       GROUP BY leader_session_key, task_id
       HAVING count > 1
       LIMIT 1`,
    )
    .get() as { leader_session_key: string; task_id: string; count: number } | undefined;
  if (collision) {
    throw new Error(
      `Cannot migrate task_records: duplicate task ${collision.task_id} for leader ${collision.leader_session_key}`,
    );
  }

  db.exec(`
    ALTER TABLE task_records RENAME TO task_records_legacy;
    CREATE TABLE task_records (
      task_id            TEXT NOT NULL,
      leader_session_key TEXT NOT NULL,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      priority           TEXT NOT NULL DEFAULT 'medium',
      executor           TEXT NOT NULL DEFAULT 'leader',
      minion_session_key TEXT,
      status             TEXT NOT NULL DEFAULT 'planned',
      result             TEXT,
      created_at         INTEGER NOT NULL,
      completed_at       INTEGER,
      PRIMARY KEY (leader_session_key, task_id)
    );
    INSERT INTO task_records (
      task_id, leader_session_key, title, description, priority,
      executor, minion_session_key, status, result, created_at, completed_at
    )
    SELECT
      task_id, leader_session_key, title, description, priority,
      executor, minion_session_key, status, result, created_at, completed_at
    FROM task_records_legacy;
    DROP TABLE task_records_legacy;
  `);
}

function ensureSystemModelUsageSchema(db: Database.Database): void {
  const rows = db.pragma("table_info(system_model_usage)") as Array<{
    name: string;
    pk: number;
  }>;
  const pk = rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  const hasNewColumns =
    rows.some((row) => row.name === "source") &&
    rows.some((row) => row.name === "session_key");
  const hasNewPk =
    pk.join(",") === "object_id,work_packet_id,source,session_key";
  if (hasNewColumns && hasNewPk) return;
  if (!rows.some((row) => row.name === "source")) {
    ensureColumn(db, "system_model_usage", "source", "TEXT NOT NULL DEFAULT 'packet'");
  }
  if (!rows.some((row) => row.name === "session_key")) {
    ensureColumn(db, "system_model_usage", "session_key", "TEXT NOT NULL DEFAULT ''");
  }

  db.exec(`
    ALTER TABLE system_model_usage RENAME TO system_model_usage_legacy;
    CREATE TABLE system_model_usage (
      object_id       TEXT NOT NULL,
      work_packet_id  TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT 'packet',
      session_key     TEXT NOT NULL DEFAULT '',
      used_at         INTEGER NOT NULL,
      PRIMARY KEY (object_id, work_packet_id, source, session_key)
    );
    INSERT OR REPLACE INTO system_model_usage (
      object_id, work_packet_id, source, session_key, used_at
    )
    SELECT
      object_id,
      COALESCE(work_packet_id, ''),
      COALESCE(source, 'packet'),
      COALESCE(session_key, ''),
      MAX(used_at)
    FROM system_model_usage_legacy
    GROUP BY
      object_id,
      COALESCE(work_packet_id, ''),
      COALESCE(source, 'packet'),
      COALESCE(session_key, '');
    DROP TABLE system_model_usage_legacy;
  `);
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
