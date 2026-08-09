import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function descriptorId(sidecarRoot: string): string | null {
  const descriptorPath = path.join(sidecarRoot, "workspace.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as Record<string, unknown>;
    const candidate = parsed["workspaceId"] ?? parsed["id"];
    return typeof candidate === "string" && UUID.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function projectDatabaseId(sidecarRoot: string): string | null {
  const databasePath = path.join(sidecarRoot, "canvas.db");
  if (!fs.existsSync(databasePath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT id FROM projects ORDER BY created_at ASC, id ASC LIMIT 2")
      .all() as Array<{ id: string }>;
    if (rows.length !== 1 || !UUID.test(rows[0]!.id)) return null;
    return rows[0]!.id;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Recover a single unambiguous opaque identity from a legacy sidecar. */
export function readLegacyWorkspaceId(sourceRoot: string): string | null {
  const sidecarRoot = path.join(sourceRoot, ".minions");
  try {
    const stat = fs.lstatSync(sidecarRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return descriptorId(sidecarRoot) ?? projectDatabaseId(sidecarRoot);
}
