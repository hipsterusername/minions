import fs from "node:fs";
import type { Request, Response, Router } from "express";
import { registerProjectPath, unregisterProjectPath } from "../../path-guard.ts";
import { addRecentProject } from "../../project-store.ts";
import { deleteDbCache } from "./helpers.ts";
import {
  attachWorkspace,
  findWorkspaceBySource,
  rebindWorkspace,
  resolveWorkspace,
} from "../../workspace-registry.ts";

/** Mount explicit identity attachment/rebind operations before UUID routes. */
export function mountWorkspaceLifecycleRoutes(router: Router): void {
  const bind = (replaceExisting: boolean) => (req: Request, res: Response) => {
    const { workspaceId, path: sourcePath } = req.body as {
      workspaceId?: string;
      path?: string;
    };
    if (typeof workspaceId !== "string" || typeof sourcePath !== "string"
      || !workspaceId || !sourcePath) {
      res.status(400).json({ error: "workspaceId and path are required" });
      return;
    }
    const current = resolveWorkspace(workspaceId);
    if (!current) {
      res.status(404).json({ error: "Workspace is not registered" });
      return;
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      res.status(404).json({ error: "Directory does not exist" });
      return;
    }
    const owner = findWorkspaceBySource(sourcePath);
    if (!replaceExisting && owner && owner.id !== workspaceId) {
      res.status(409).json({ error: "Repository is already attached to another workspace" });
      return;
    }
    const rebound = replaceExisting
      ? attachWorkspace(workspaceId, sourcePath)
      : rebindWorkspace(workspaceId, sourcePath);
    if (!rebound || !registerProjectPath(rebound.sourceRoot)) {
      res.status(403).json({ error: "Repository could not be attached" });
      return;
    }
    if (current.sourceRoot !== rebound.sourceRoot) {
      unregisterProjectPath(current.sourceRoot);
      deleteDbCache(current.sourceRoot);
    }
    if (owner && owner.id !== workspaceId) deleteDbCache(rebound.sourceRoot);
    addRecentProject(rebound.sourceRoot, rebound.nickname);
    res.json({
      id: rebound.id,
      workspaceId: rebound.id,
      path: rebound.sourceRoot,
      sourceRoot: rebound.sourceRoot,
      name: rebound.nickname,
      nickname: rebound.nickname,
      createdAt: rebound.createdAt,
    });
  };
  router.post("/rebind", bind(false));
  router.post("/attach", bind(true));
}
