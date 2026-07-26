import type Database from "better-sqlite3";

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

const OLD_RUN_OUTCOME_CHECK =
  "CHECK (run_outcome IN ('none', 'completed', 'error', 'interrupted'))";
const RUN_OUTCOME_CHECK =
  "CHECK (run_outcome IN ('none', 'completed', 'error', 'stopped', 'interrupted'))";

/**
 * SQLite cannot alter a column CHECK in place. Rebuild only databases that
 * still carry the old four-outcome constraint, copying every row verbatim and
 * restoring every caller-owned sessions index/trigger afterward.
 */
function ensureStoppedRunOutcome(db: Database.Database): void {
  const table = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'sessions'`).get() as { sql: string } | undefined;
  if (!table?.sql.includes(OLD_RUN_OUTCOME_CHECK)) return;

  const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'sessions' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name`).all() as Array<{
      type: "index" | "trigger"; name: string; sql: string;
    }>;
  const columns = (db.pragma("table_info(sessions)") as Array<{ name: string }>)
    .map((row) => `"${row.name.replaceAll('"', '""')}"`).join(", ");
  const createSql = table.sql
    .replace(
      /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"sessions"|`sessions`|\[sessions\]|sessions)/i,
      "CREATE TABLE sessions_run_outcome_migration",
    )
    .replace(OLD_RUN_OUTCOME_CHECK, RUN_OUTCOME_CHECK);
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  if (foreignKeys) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(createSql);
      db.exec(`INSERT INTO sessions_run_outcome_migration (${columns})
        SELECT ${columns} FROM sessions`);
      db.exec("DROP TABLE sessions");
      db.exec("ALTER TABLE sessions_run_outcome_migration RENAME TO sessions");
      for (const object of objects) {
        if (object.name === "validate_work_item_run_insert"
          || object.name === "validate_work_item_run_update") continue;
        db.exec(object.sql);
      }
    }).immediate();
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
}

/** Install canonical work-item/run storage in the global server database. */
export function ensureWorkItemSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL,
      project_path          TEXT NOT NULL,
      title                 TEXT NOT NULL,
      runtime_state         TEXT NOT NULL,
      outcome               TEXT NOT NULL,
      resolution            TEXT NOT NULL,
      change_mode           TEXT NOT NULL,
      integration_state     TEXT NOT NULL,
      wait_kind             TEXT,
      archived_from_resolution TEXT CHECK (archived_from_resolution IN ('open', 'reviewed')),
      current_run_key       TEXT,
      iteration             INTEGER NOT NULL DEFAULT 0,
      workflow_column_id    TEXT NOT NULL DEFAULT 'backlog',
      workflow_rank         TEXT NOT NULL,
      workflow_revision     INTEGER NOT NULL DEFAULT 0,
      kanban_json           TEXT NOT NULL DEFAULT '{}',
      lifecycle_revision    INTEGER NOT NULL DEFAULT 0,
      last_transition_at    INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_item_bindings (
      work_item_id  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      surface       TEXT NOT NULL CHECK (surface IN ('canvas', 'kanban')),
      binding_id    TEXT NOT NULL,
      attached_at   INTEGER NOT NULL,
      detached_at   INTEGER,
      PRIMARY KEY (work_item_id, surface, binding_id)
    );

    CREATE TABLE IF NOT EXISTS work_item_commands (
      request_id    TEXT PRIMARY KEY,
      work_item_id  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      command       TEXT NOT NULL,
      input_hash    TEXT NOT NULL,
      result_key    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_item_run_reports (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      run_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      report_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(run_key)
    );

    CREATE TABLE IF NOT EXISTS work_item_imports (
      project_id TEXT NOT NULL,
      migration_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      imported_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, migration_key)
    );

    CREATE TABLE IF NOT EXISTS work_item_import_entries (
      project_id TEXT NOT NULL,
      migration_key TEXT NOT NULL,
      legacy_card_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      PRIMARY KEY (project_id, migration_key, legacy_card_id),
      UNIQUE (project_id, migration_key, work_item_id)
    );

    CREATE TABLE IF NOT EXISTS run_invocations (
      run_key               TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      provider_generation   INTEGER NOT NULL CHECK (provider_generation > 0),
      sequence              INTEGER NOT NULL UNIQUE,
      phase                 TEXT NOT NULL CHECK (phase IN ('opening', 'running', 'terminal', 'lost')),
      terminal_kind         TEXT CHECK (terminal_kind IN ('clean', 'error', 'cancelled', 'lost')),
      terminal_source       TEXT CHECK (terminal_source IN ('provider', 'adapter', 'server', 'boot')),
      termination_intent    TEXT CHECK (termination_intent IN ('stop', 'close', 'remove', 'abort', 'timeout', 'shutdown')),
      provider_id           TEXT NOT NULL,
      provider_session_id   TEXT,
      started_at            INTEGER NOT NULL,
      terminal_at           INTEGER,
      PRIMARY KEY (run_key, provider_generation),
      CHECK (
        (phase IN ('opening', 'running') AND terminal_kind IS NULL
          AND terminal_source IS NULL AND terminal_at IS NULL)
        OR
        (phase = 'terminal' AND terminal_kind IN ('clean', 'error', 'cancelled')
          AND terminal_source IS NOT NULL AND terminal_at IS NOT NULL)
        OR
        (phase = 'lost' AND terminal_kind = 'lost'
          AND terminal_source IS NOT NULL AND terminal_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_project
      ON work_items(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_item_bindings_surface
      ON work_item_bindings(surface, binding_id);
    CREATE INDEX IF NOT EXISTS idx_run_invocations_run
      ON run_invocations(run_key, provider_generation DESC);
  `);

  ensureColumn(db, "work_items", "archived_from_resolution", "TEXT CHECK (archived_from_resolution IN ('open', 'reviewed'))");
  ensureColumn(db, "work_items", "workflow_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "work_items", "kanban_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "work_item_commands", "result_key", "TEXT");

  ensureColumn(db, "sessions", "work_item_id", "TEXT REFERENCES work_items(id)");
  ensureColumn(db, "sessions", "run_number", "INTEGER");
  ensureColumn(db, "sessions", "run_kind", "TEXT NOT NULL DEFAULT 'primary' CHECK (run_kind IN ('primary', 'child'))");
  ensureColumn(db, "sessions", "previous_run_key", "TEXT");
  ensureColumn(db, "sessions", "parent_run_key", "TEXT");
  ensureColumn(db, "sessions", "task_id", "TEXT");
  ensureColumn(db, "sessions", "started_at", "INTEGER");
  ensureColumn(db, "sessions", "ended_at", "INTEGER");
  ensureColumn(db, "sessions", "run_outcome", `TEXT NOT NULL DEFAULT 'none' ${RUN_OUTCOME_CHECK}`);
  ensureColumn(db, "sessions", "final_report_event_id", "TEXT");
  ensureColumn(db, "sessions", "start_idempotency_key", "TEXT");
  ensureColumn(db, "sessions", "provider_generation", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "run_config_json", "TEXT");
  ensureStoppedRunOutcome(db);

  db.exec(`
    DROP TRIGGER IF EXISTS validate_work_item_run_insert;
    DROP TRIGGER IF EXISTS validate_work_item_run_update;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_work_item_run
      ON sessions(work_item_id, run_number)
      WHERE work_item_id IS NOT NULL AND run_number IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_work_item_start_idempotency
      ON sessions(work_item_id, start_idempotency_key)
      WHERE work_item_id IS NOT NULL AND start_idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_unsealed_primary
      ON sessions(work_item_id)
      WHERE work_item_id IS NOT NULL AND run_kind = 'primary' AND ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_parent_run
      ON sessions(parent_run_key, started_at)
      WHERE parent_run_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_parent_task
      ON sessions(parent_run_key, task_id)
      WHERE run_kind = 'child' AND parent_run_key IS NOT NULL AND task_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_bindings_active_surface
      ON work_item_bindings(surface, binding_id)
      WHERE detached_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS validate_work_item_run_insert
    BEFORE INSERT ON sessions
    WHEN NEW.work_item_id IS NOT NULL AND (
      NEW.run_kind NOT IN ('primary', 'child') OR
      NEW.run_outcome NOT IN ('none', 'completed', 'error', 'stopped', 'interrupted') OR
      (NEW.run_kind = 'primary' AND (NEW.run_number IS NULL OR NEW.parent_run_key IS NOT NULL OR NEW.task_id IS NOT NULL)) OR
      (NEW.run_kind = 'child' AND (NEW.run_number IS NOT NULL OR NEW.parent_run_key IS NULL OR NEW.task_id IS NULL)) OR
      (NEW.ended_at IS NULL AND NEW.run_outcome <> 'none') OR
      (NEW.ended_at IS NOT NULL AND NEW.run_outcome = 'none')
    ) BEGIN SELECT RAISE(ABORT, 'invalid work-item run shape'); END;

    CREATE TRIGGER IF NOT EXISTS validate_work_item_run_update
    BEFORE UPDATE OF work_item_id, run_number, run_kind, parent_run_key, task_id, ended_at, run_outcome ON sessions
    WHEN NEW.work_item_id IS NOT NULL AND (
      NEW.run_kind NOT IN ('primary', 'child') OR
      NEW.run_outcome NOT IN ('none', 'completed', 'error', 'stopped', 'interrupted') OR
      (NEW.run_kind = 'primary' AND (NEW.run_number IS NULL OR NEW.parent_run_key IS NOT NULL OR NEW.task_id IS NOT NULL)) OR
      (NEW.run_kind = 'child' AND (NEW.run_number IS NOT NULL OR NEW.parent_run_key IS NULL OR NEW.task_id IS NULL)) OR
      (NEW.ended_at IS NULL AND NEW.run_outcome <> 'none') OR
      (NEW.ended_at IS NOT NULL AND NEW.run_outcome = 'none')
    ) BEGIN SELECT RAISE(ABORT, 'invalid work-item run shape'); END;
  `);
}
