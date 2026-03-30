import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  listRecentProjects,
  addRecentProject,
  removeRecentProject,
  openProjectDb,
  initSidecar,
  hasSidecar,
  readContext,
  writeContext,
  readSettings,
  writeSettings,
} from "../project-store.ts";
import type { ProjectSettings } from "../project-store.ts";

// ── Helpers ──────────────────────────────────────────────

// Encode/decode project paths for use in URLs
function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

function decodePath(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

/** Safely extract a route param as a string (Express 5 returns string | string[]) */
function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0]! : v ?? "";
}

interface ProjectRow {
  id: string;
  name: string;
  transform_x: number;
  transform_y: number;
  transform_scale: number;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
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

function rowToProject(row: ProjectRow, projectPath: string) {
  return {
    id: encodePath(projectPath),
    path: projectPath,
    name: row.name,
    transform: {
      x: row.transform_x,
      y: row.transform_y,
      scale: row.transform_scale,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToNode(row: NodeRow) {
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

// Keep a cache of open DB handles so we don't re-open on every request
const dbCache = new Map<string, ReturnType<typeof openProjectDb>>();

function getDb(projectPath: string) {
  let db = dbCache.get(projectPath);
  if (!db) {
    db = openProjectDb(projectPath);
    dbCache.set(projectPath, db);
  }
  return db;
}

// Ensure at least one project row exists in the per-project DB
function ensureProjectRow(db: ReturnType<typeof openProjectDb>, projectPath: string): string {
  const row = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined;
  if (row) return row.id;

  const id = crypto.randomUUID();
  const name = path.basename(projectPath);
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
  return id;
}

// ── Routes ───────────────────────────────────────────────

export function createProjectRoutes(): Router {
  const router = Router();

  // List recent projects
  router.get("/", (_req: Request, res: Response) => {
    const recents = listRecentProjects();
    res.json(
      recents.map((r) => ({
        id: encodePath(r.path),
        path: r.path,
        name: r.name,
        lastOpened: r.lastOpened,
        hasSidecar: hasSidecar(r.path),
      })),
    );
  });

  // Create a new project (creates folder + sidecar)
  router.post("/", (req: Request, res: Response) => {
    const { name, path: projectPath } = req.body as { name?: string; path?: string };

    if (!projectPath) {
      res.status(400).json({ error: "Project path is required" });
      return;
    }

    const absPath = path.resolve(projectPath);

    // Create the project directory if it doesn't exist
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(absPath, { recursive: true });
    }

    const db = initSidecar(absPath);
    const projectName = name ?? path.basename(absPath);

    // Create the project row
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, projectName);

    addRecentProject(absPath, projectName);
    dbCache.set(absPath, db);

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;

    res.status(201).json({
      ...rowToProject(row, absPath),
      context: readContext(absPath),
      settings: readSettings(absPath),
    });
  });

  // Open an existing folder as a project
  router.post("/open", (req: Request, res: Response) => {
    const { path: projectPath } = req.body as { path?: string };

    if (!projectPath) {
      res.status(400).json({ error: "Project path is required" });
      return;
    }

    const absPath = path.resolve(projectPath);

    if (!fs.existsSync(absPath)) {
      res.status(404).json({ error: "Directory does not exist" });
      return;
    }

    const db = getDb(absPath);
    const projectId = ensureProjectRow(db, absPath);
    const projectName = path.basename(absPath);

    addRecentProject(absPath, projectName);

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow;
    const nodeRows = db
      .prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY z_index ASC, created_at ASC")
      .all(projectId) as NodeRow[];

    res.json({
      ...rowToProject(row, absPath),
      nodes: nodeRows.map(rowToNode),
      context: readContext(absPath),
      settings: readSettings(absPath),
    });
  });

  // Get a project by encoded path
  router.get("/:encodedPath", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));

    if (!fs.existsSync(projectPath)) {
      res.status(404).json({ error: "Project directory not found" });
      return;
    }

    const db = getDb(projectPath);
    const projectId = ensureProjectRow(db, projectPath);

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow;
    const nodeRows = db
      .prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY z_index ASC, created_at ASC")
      .all(projectId) as NodeRow[];

    // Touch recent projects
    addRecentProject(projectPath, row.name);

    res.json({
      ...rowToProject(row, projectPath),
      nodes: nodeRows.map(rowToNode),
      context: readContext(projectPath),
      settings: readSettings(projectPath),
    });
  });

  // Update project metadata / transform
  router.put("/:encodedPath", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    const { name, transform } = req.body as {
      name?: string;
      transform?: { x: number; y: number; scale: number };
    };

    const db = getDb(projectPath);
    const projectId = ensureProjectRow(db, projectPath);

    if (name !== undefined) {
      db.prepare(
        "UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(name, projectId);
      addRecentProject(projectPath, name);
    }

    if (transform) {
      db.prepare(
        `UPDATE projects
         SET transform_x = ?, transform_y = ?, transform_scale = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      ).run(transform.x, transform.y, transform.scale, projectId);
    }

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow;
    res.json(rowToProject(row, projectPath));
  });

  // Delete a project from recent list (does NOT delete the folder)
  router.delete("/:encodedPath", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    removeRecentProject(projectPath);
    dbCache.delete(projectPath);
    res.json({ ok: true });
  });

  // Bulk save: replace all nodes + update transform
  router.put("/:encodedPath/state", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    const { transform, nodes } = req.body as {
      transform?: { x: number; y: number; scale: number };
      nodes?: Array<{
        id: string;
        type: string;
        position: { x: number; y: number };
        size: { width: number; height: number };
        data: unknown;
      }>;
    };

    const db = getDb(projectPath);
    const projectId = ensureProjectRow(db, projectPath);

    const saveTransaction = db.transaction(() => {
      if (transform) {
        db.prepare(
          `UPDATE projects
           SET transform_x = ?, transform_y = ?, transform_scale = ?,
               updated_at = datetime('now')
           WHERE id = ?`,
        ).run(transform.x, transform.y, transform.scale, projectId);
      }

      if (nodes) {
        db.prepare("DELETE FROM nodes WHERE project_id = ?").run(projectId);

        const insert = db.prepare(
          `INSERT INTO nodes (id, project_id, type, pos_x, pos_y, width, height, data, z_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]!;
          insert.run(
            n.id,
            projectId,
            n.type,
            n.position.x,
            n.position.y,
            n.size.width,
            n.size.height,
            JSON.stringify(n.data),
            i,
          );
        }
      }
    });

    saveTransaction();
    res.json({ ok: true });
  });

  // ── Context.md routes ────────────────────────────────

  router.get("/:encodedPath/context", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    res.json(readContext(projectPath));
  });

  router.put("/:encodedPath/context", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    const { content } = req.body as { content: string };
    writeContext(projectPath, content);
    res.json({ ok: true });
  });

  // ── Settings routes ──────────────────────────────────

  router.get("/:encodedPath/settings", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    res.json(readSettings(projectPath));
  });

  router.put("/:encodedPath/settings", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    const settings = req.body as ProjectSettings;
    writeSettings(projectPath, settings);
    res.json({ ok: true });
  });

  // ── Directory tree (high-level) ──────────────────────
  router.get("/:encodedPath/tree", (req: Request, res: Response) => {
    const projectPath = decodePath(param(req, "encodedPath"));
    const depthParam = req.query["depth"];
    const maxDepth = typeof depthParam === "string" ? Math.min(parseInt(depthParam, 10) || 2, 4) : 2;

    interface TreeNode {
      name: string;
      path: string;       // relative to project root
      type: "dir" | "file";
      children?: TreeNode[];
    }

    // Directories/files to always skip
    const SKIP = new Set([
      "node_modules", ".git", ".next", ".cache", "dist", "build",
      ".turbo", ".vercel", ".DS_Store", "__pycache__", ".canvas-worktrees",
      ".canvas", "coverage", ".nyc_output", ".parcel-cache",
    ]);

    function scanDir(absPath: string, relPath: string, depth: number): TreeNode[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absPath, { withFileTypes: true });
      } catch {
        return [];
      }

      const result: TreeNode[] = [];
      // Sort: dirs first, then files, alpha within each
      const dirs = entries.filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter(e => e.isFile() && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));

      for (const d of dirs) {
        const childRel = relPath ? `${relPath}/${d.name}` : d.name;
        const childAbs = path.join(absPath, d.name);
        const node: TreeNode = { name: d.name, path: childRel, type: "dir" };
        if (depth < maxDepth) {
          node.children = scanDir(childAbs, childRel, depth + 1);
        }
        result.push(node);
      }
      for (const f of files) {
        const childRel = relPath ? `${relPath}/${f.name}` : f.name;
        result.push({ name: f.name, path: childRel, type: "file" });
      }
      return result;
    }

    try {
      const tree = scanDir(projectPath, "", 0);
      res.json({ root: path.basename(projectPath), tree });
    } catch (err) {
      res.status(500).json({ error: "Failed to scan directory" });
    }
  });

  return router;
}
