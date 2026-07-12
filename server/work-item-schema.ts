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

    CREATE INDEX IF NOT EXISTS idx_work_items_project
      ON work_items(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_item_bindings_surface
      ON work_item_bindings(surface, binding_id);
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
  ensureColumn(db, "sessions", "run_outcome", "TEXT NOT NULL DEFAULT 'none' CHECK (run_outcome IN ('none', 'completed', 'error', 'interrupted'))");
  ensureColumn(db, "sessions", "final_report_event_id", "TEXT");
  ensureColumn(db, "sessions", "start_idempotency_key", "TEXT");
  ensureColumn(db, "sessions", "provider_generation", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "run_config_json", "TEXT");

  db.exec(`
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
      NEW.run_outcome NOT IN ('none', 'completed', 'error', 'interrupted') OR
      (NEW.run_kind = 'primary' AND (NEW.run_number IS NULL OR NEW.parent_run_key IS NOT NULL OR NEW.task_id IS NOT NULL)) OR
      (NEW.run_kind = 'child' AND (NEW.run_number IS NOT NULL OR NEW.parent_run_key IS NULL OR NEW.task_id IS NULL)) OR
      (NEW.ended_at IS NULL AND NEW.run_outcome <> 'none') OR
      (NEW.ended_at IS NOT NULL AND NEW.run_outcome = 'none')
    ) BEGIN SELECT RAISE(ABORT, 'invalid work-item run shape'); END;

    CREATE TRIGGER IF NOT EXISTS validate_work_item_run_update
    BEFORE UPDATE OF work_item_id, run_number, run_kind, parent_run_key, task_id, ended_at, run_outcome ON sessions
    WHEN NEW.work_item_id IS NOT NULL AND (
      NEW.run_kind NOT IN ('primary', 'child') OR
      NEW.run_outcome NOT IN ('none', 'completed', 'error', 'interrupted') OR
      (NEW.run_kind = 'primary' AND (NEW.run_number IS NULL OR NEW.parent_run_key IS NOT NULL OR NEW.task_id IS NOT NULL)) OR
      (NEW.run_kind = 'child' AND (NEW.run_number IS NOT NULL OR NEW.parent_run_key IS NULL OR NEW.task_id IS NULL)) OR
      (NEW.ended_at IS NULL AND NEW.run_outcome <> 'none') OR
      (NEW.ended_at IS NOT NULL AND NEW.run_outcome = 'none')
    ) BEGIN SELECT RAISE(ABORT, 'invalid work-item run shape'); END;
  `);
}
