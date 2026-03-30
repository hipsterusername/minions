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
  `);

  return db;
}
