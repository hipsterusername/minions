import type { Request } from "express";
import crypto from "crypto";
import path from "path";
import { openProjectDb } from "../../project-store.ts";
import { validateProjectPath } from "../../path-guard.ts";
import { findWorkspaceBySource, resolveWorkspace } from "../../workspace-registry.ts";

/** Encode a project path for use in URLs */
export function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

/** Decode a URL-safe project path */
export function decodePath(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

/** Safely extract a route param as a string (Express 5 returns string | string[]) */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0]! : v ?? "";
}

/** Resolve either a stable workspace UUID or the temporary encoded-path route key. */
export function resolveProjectReference(reference: string): string | null {
  const workspace = resolveWorkspace(reference);
  if (workspace) return validateProjectPath(workspace.sourceRoot);
  return validateProjectPath(decodePath(reference));
}

export interface ProjectRow {
  id: string;
  name: string;
  transform_x: number;
  transform_y: number;
  transform_scale: number;
  created_at: string;
  updated_at: string;
}

export interface NodeRow {
  id: string;
  project_id: string;
  type: string;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  data: string;
  z_index: number;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  project_id: string;
  source_node_id: string;
  source_port_id: string;
  target_node_id: string;
  target_port_id: string;
  protocol: string;
  z_index: number;
  context_mode: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToProject(row: ProjectRow, projectPath: string) {
  const workspace = findWorkspaceBySource(projectPath);
  return {
    id: workspace?.id ?? encodePath(projectPath),
    workspaceId: workspace?.id,
    path: projectPath,
    sourceRoot: projectPath,
    name: row.name,
    nickname: workspace?.nickname ?? row.name,
    transform: {
      x: row.transform_x,
      y: row.transform_y,
      scale: row.transform_scale,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToNode(row: NodeRow) {
  let parsedData: unknown = {};
  try {
    parsedData = JSON.parse(row.data);
  } catch {
    // keep default
  }
  return {
    id: row.id,
    type: row.type,
    position: { x: row.pos_x, y: row.pos_y },
    size: { width: row.width, height: row.height },
    data: parsedData,
  };
}

export function rowToEdge(row: EdgeRow) {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    sourcePortId: row.source_port_id,
    targetNodeId: row.target_node_id,
    targetPortId: row.target_port_id,
    protocol: row.protocol,
    ...(row.context_mode
      ? { contextMode: row.context_mode as "dashboard" | "lean" | "full" }
      : {}),
  };
}

/** Keep a cache of open DB handles so we don't re-open on every request */
const dbCache = new Map<string, ReturnType<typeof openProjectDb>>();

export function getDb(projectPath: string) {
  let db = dbCache.get(projectPath);
  if (!db) {
    db = openProjectDb(projectPath);
    dbCache.set(projectPath, db);
  }
  return db;
}

export function setDbCache(projectPath: string, db: ReturnType<typeof openProjectDb>) {
  dbCache.set(projectPath, db);
}

export function deleteDbCache(projectPath: string) {
  dbCache.delete(projectPath);
}

/** Ensure at least one project row exists in the per-project DB */
export function ensureProjectRow(db: ReturnType<typeof openProjectDb>, projectPath: string): string {
  const row = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined;
  if (row) return row.id;

  const id = crypto.randomUUID();
  const name = path.basename(projectPath);
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
