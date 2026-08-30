import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  listRecentProjects,
  addRecentProject,
  removeRecentProject,
  initSidecar,
  hasSidecar,
  readContext,
  readSettings,
  readSkills,
} from "../../project-store.ts";
import {
  registerProjectPath,
  unregisterProjectPath,
} from "../../path-guard.ts";
import {
  encodePath,
  param,
  resolveProjectReference,
  getDb,
  setDbCache,
  deleteDbCache,
  ensureProjectRow,
  rowToProject,
  rowToNode,
  rowToEdge,
} from "./helpers.ts";
import type { ProjectRow, NodeRow, EdgeRow } from "./helpers.ts";
import { getHarnessReadiness } from "../../harness/readiness.ts";
import type { HarnessReadinessSnapshot } from "../../harness/readiness-types.ts";
import { resolveNewProjectDefaults } from "../../project-defaults.ts";
import {
  canonicalizeSourceRoot,
  findWorkspaceBySource,
  registerWorkspace,
  resolveWorkspace,
  updateWorkspaceNickname,
} from "../../workspace-registry.ts";
import { mountWorkspaceLifecycleRoutes } from "./workspace-lifecycle.ts";
import {
  ensureProjectGitReady,
  mountProjectGitRoutes,
  type ProjectGitDependencies,
} from "./git.ts";

interface StateEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  protocol: string;
  contextMode?: "dashboard" | "lean" | "full";
}

function loadProjectEdges(db: ReturnType<typeof getDb>, projectId: string): StateEdge[] {
  const edgeRows = db
    .prepare("SELECT * FROM edges WHERE project_id = ? ORDER BY z_index ASC, created_at ASC")
    .all(projectId) as EdgeRow[];
  return edgeRows.map(rowToEdge);
}

export function mountCoreRoutes(
  router: Router,
  deps: {
    getReadiness?: (opts: { fresh: true }) => Promise<HarnessReadinessSnapshot>;
    projectGit?: ProjectGitDependencies;
  } = {},
): void {
  const readiness = deps.getReadiness ?? getHarnessReadiness;
  mountProjectGitRoutes(router, deps.projectGit);
  // Restore the path allowlist from durable storage so projects remain
  // accessible across server restarts without requiring re-open.
  for (const recent of listRecentProjects()) {
    const workspace = (recent.id ? resolveWorkspace(recent.id) : null)
      ?? registerWorkspace(recent.path, { nickname: recent.name });
    if (workspace) registerProjectPath(workspace.sourceRoot);
  }

  router.get("/", (_req: Request, res: Response) => {
    const recents = listRecentProjects();
    res.json(
      recents.map((r) => {
        const workspace = (r.id ? resolveWorkspace(r.id) : null) ?? findWorkspaceBySource(r.path);
        return {
        id: workspace?.id ?? encodePath(r.path),
        workspaceId: workspace?.id,
        path: workspace?.sourceRoot ?? r.path,
        sourceRoot: workspace?.sourceRoot ?? r.path,
        name: workspace?.nickname ?? r.name,
        nickname: workspace?.nickname ?? r.name,
        lastOpened: r.lastOpened,
        hasSidecar: hasSidecar(workspace?.sourceRoot ?? r.path),
      }; }),
    );
  });

  router.post("/", async (req: Request, res: Response) => {
    const { name, path: projectPath, gitAction } = req.body as {
      name?: string;
      path?: string;
      gitAction?: unknown;
    };

    if (!projectPath) {
      res.status(400).json({ error: "Project path is required" });
      return;
    }

    const canonicalPath = canonicalizeSourceRoot(projectPath);
    if (!canonicalPath) {
      res.status(403).json({ error: "Project path must be an absolute canonical source root" });
      return;
    }
    const gitReady = ensureProjectGitReady(res, canonicalPath, gitAction, deps.projectGit);
    if (typeof gitReady === "boolean" ? !gitReady : !(await gitReady)) return;

    const snapshot = await readiness({ fresh: true });
    const initialSettings = resolveNewProjectDefaults(snapshot);
    if (!initialSettings) {
      res.status(409).json({ code: "HARNESS_NOT_READY", readiness: snapshot });
      return;
    }

    const projectName = name ?? path.basename(canonicalPath);
    const workspace = registerWorkspace(canonicalPath, { nickname: projectName });
    const absPath = workspace && registerProjectPath(workspace.sourceRoot);
    if (!workspace || !absPath) {
      res.status(403).json({ error: "Project path could not be registered" });
      return;
    }

    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(absPath, { recursive: true });
    }

    const db = initSidecar(absPath, initialSettings);
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, projectName);

    addRecentProject(absPath, projectName);
    setDbCache(absPath, db);

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;

    res.status(201).json({
      ...rowToProject(row, absPath),
      nodes: [],
      graph: { edges: [] },
      context: readContext(absPath),
      settings: readSettings(absPath),
      skills: readSkills(absPath),
    });
  });

  router.post("/open", async (req: Request, res: Response) => {
    const { path: projectPath, gitAction } = req.body as { path?: string; gitAction?: unknown };

    if (!projectPath) {
      res.status(400).json({ error: "Project path is required" });
      return;
    }

    if (!path.isAbsolute(projectPath) || !fs.existsSync(projectPath)) {
      res.status(404).json({ error: "Directory does not exist" });
      return;
    }
    const canonicalPath = canonicalizeSourceRoot(projectPath);
    if (!canonicalPath) {
      res.status(403).json({ error: "Project path must be an absolute canonical source root" });
      return;
    }
    const gitReady = ensureProjectGitReady(res, canonicalPath, gitAction, deps.projectGit);
    if (typeof gitReady === "boolean" ? !gitReady : !(await gitReady)) return;
    const workspace = registerWorkspace(projectPath);
    const absPath = workspace && registerProjectPath(workspace.sourceRoot);
    if (!workspace || !absPath) {
      res.status(403).json({ error: "Project path must be an absolute canonical source root" });
      return;
    }

    if (!hasSidecar(absPath)) {
      const snapshot = await readiness({ fresh: true });
      const initialSettings = resolveNewProjectDefaults(snapshot);
      if (!initialSettings) {
        res.status(409).json({ code: "HARNESS_NOT_READY", readiness: snapshot });
        return;
      }
      setDbCache(absPath, initSidecar(absPath, initialSettings));
    }
    const db = getDb(absPath);
    const projectId = ensureProjectRow(db, absPath);
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow;
    addRecentProject(absPath, row.name);
    const nodeRows = db
      .prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY z_index ASC, created_at ASC")
      .all(projectId) as NodeRow[];

    res.json({
      ...rowToProject(row, absPath),
      nodes: nodeRows.map(rowToNode),
      graph: { edges: loadProjectEdges(db, projectId) },
      context: readContext(absPath),
      settings: readSettings(absPath),
      skills: readSkills(absPath),
    });
  });

  mountWorkspaceLifecycleRoutes(router);

  router.get("/:encodedPath", async (req: Request, res: Response) => {
    const projectPath = resolveProjectReference(param(req, "encodedPath"));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered" });
      return;
    }

    if (!fs.existsSync(projectPath)) {
      res.status(404).json({ error: "Project directory not found" });
      return;
    }

    if (!hasSidecar(projectPath)) {
      const snapshot = await readiness({ fresh: true });
      const initialSettings = resolveNewProjectDefaults(snapshot);
      if (!initialSettings) {
        res.status(409).json({ code: "HARNESS_NOT_READY", readiness: snapshot });
        return;
      }
      setDbCache(projectPath, initSidecar(projectPath, initialSettings));
    }
    const db = getDb(projectPath);
    const projectId = ensureProjectRow(db, projectPath);

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow;
    const nodeRows = db
      .prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY z_index ASC, created_at ASC")
      .all(projectId) as NodeRow[];

    addRecentProject(projectPath, row.name);

    res.json({
      ...rowToProject(row, projectPath),
      nodes: nodeRows.map(rowToNode),
      graph: { edges: loadProjectEdges(db, projectId) },
      context: readContext(projectPath),
      settings: readSettings(projectPath),
      skills: readSkills(projectPath),
    });
  });

  router.put("/:encodedPath", (req: Request, res: Response) => {
    const projectPath = resolveProjectReference(param(req, "encodedPath"));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered" });
      return;
    }
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
      const workspace = findWorkspaceBySource(projectPath);
      if (workspace) updateWorkspaceNickname(workspace.id, name);
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
    const projectPath = resolveProjectReference(param(req, "encodedPath"));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered" });
      return;
    }
    removeRecentProject(projectPath);
    unregisterProjectPath(projectPath);
    deleteDbCache(projectPath);
    res.json({ ok: true });
  });

  router.put("/:encodedPath/state", (req: Request, res: Response) => {
    const projectPath = resolveProjectReference(param(req, "encodedPath"));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered" });
      return;
    }
    const { transform, nodes, graph } = req.body as {
      transform?: { x: number; y: number; scale: number };
      nodes?: Array<{
        id: string;
        type: string;
        position: { x: number; y: number };
        size: { width: number; height: number };
        data: unknown;
      }>;
      graph?: { edges?: StateEdge[] };
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

      if (graph?.edges) {
        db.prepare("DELETE FROM edges WHERE project_id = ?").run(projectId);

        const insert = db.prepare(
          `INSERT INTO edges (
             id, project_id, source_node_id, source_port_id,
             target_node_id, target_port_id, protocol, z_index, context_mode
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (let i = 0; i < graph.edges.length; i++) {
          const e = graph.edges[i]!;
          insert.run(
            e.id,
            projectId,
            e.sourceNodeId,
            e.sourcePortId,
            e.targetNodeId,
            e.targetPortId,
            e.protocol,
            i,
            e.contextMode ?? null,
          );
        }
      }
    });

    saveTransaction();
    res.json({ ok: true });
  });
}
