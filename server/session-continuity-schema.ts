import type Database from "better-sqlite3";

/** Idempotent continuity storage for both compatibility and canonical sessions. */
export function ensureSessionContinuitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_user_directives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_user_directives_session
      ON session_user_directives(session_key, id);

    CREATE TABLE IF NOT EXISTS session_continuity (
      session_key TEXT PRIMARY KEY REFERENCES sessions(session_key) ON DELETE CASCADE,
      snapshot_json TEXT NOT NULL
    );

  `);
}
