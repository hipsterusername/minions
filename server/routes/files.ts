import { Router } from "express";
import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  resolveCreatableProjectPath,
  resolveExistingProjectPath,
  validateProjectPath,
} from "../path-guard.ts";

export function createFileRoutes(): Router {
  const router = Router();

  /**
   * POST /api/files/save
   * Body: { projectPath: string, filePath: string, content: string }
   *
   * Saves content to a file relative to the project root.
   * Creates intermediate directories as needed.
   */
  router.post("/save", async (req: Request, res: Response) => {
    const { projectPath, filePath, content } = req.body as {
      projectPath?: string;
      filePath?: string;
      content?: string;
    };

    if (!projectPath || !filePath || content === undefined) {
      res.status(400).json({ error: "Missing required fields: projectPath, filePath, content" });
      return;
    }

    const validatedProject = validateProjectPath(projectPath);
    if (!validatedProject) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }

    const resolved = await resolveCreatableProjectPath(validatedProject, filePath);
    if (!resolved) {
      res.status(403).json({ error: "Path escapes project root" });
      return;
    }

    try {
      const dir = path.dirname(resolved);
      await fs.promises.mkdir(dir, { recursive: true });

      await fs.promises.writeFile(resolved, content, "utf-8");

      res.json({
        ok: true,
        savedPath: resolved,
        relativePath: path.relative(validatedProject, resolved),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to save file: ${message}` });
    }
  });

  /**
   * GET /api/files/list-dirs?projectPath=...&subPath=...
   *
   * Lists directories (and optionally files) at the given subPath within projectPath.
   * Returns { dirs: string[], files: string[], currentPath: string }
   */
  router.get("/list-dirs", async (req: Request, res: Response) => {
    const projectPath = req.query["projectPath"] as string | undefined;
    const subPath = (req.query["subPath"] as string | undefined) ?? ".";

    if (!projectPath) {
      res.status(400).json({ error: "Missing required query param: projectPath" });
      return;
    }

    const validatedProject = validateProjectPath(projectPath);
    if (!validatedProject) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }

    const resolved = await resolveExistingProjectPath(validatedProject, subPath);
    if (!resolved) {
      res.status(403).json({ error: "Path escapes project root" });
      return;
    }

    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });

      const dirs: string[] = [];
      for (const entry of entries) {
        // Skip hidden dirs and common non-useful directories
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        if (entry.isDirectory()) {
          dirs.push(entry.name);
        }
      }

      dirs.sort((a, b) => a.localeCompare(b));

      const relativeCurrent = path.relative(validatedProject, resolved) || ".";

      res.json({
        dirs,
        currentPath: relativeCurrent,
        projectRoot: path.basename(validatedProject),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to list directory: ${message}` });
    }
  });

  /**
   * POST /api/files/upload
   * Body: { projectPath: string, filePath: string, contentBase64: string }
   *
   * Saves a file from base64-encoded content. Used for drag-and-drop file uploads.
   * Creates intermediate directories as needed.
   */
  router.post("/upload", async (req: Request, res: Response) => {
    const { projectPath, filePath, contentBase64 } = req.body as {
      projectPath?: string;
      filePath?: string;
      contentBase64?: string;
    };

    if (!projectPath || !filePath || !contentBase64) {
      res.status(400).json({ error: "Missing required fields: projectPath, filePath, contentBase64" });
      return;
    }

    const validatedProject = validateProjectPath(projectPath);
    if (!validatedProject) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }

    const resolved = await resolveCreatableProjectPath(validatedProject, filePath);
    if (!resolved) {
      res.status(403).json({ error: "Path escapes project root" });
      return;
    }

    try {
      const dir = path.dirname(resolved);
      await fs.promises.mkdir(dir, { recursive: true });
      const buffer = Buffer.from(contentBase64, "base64");
      await fs.promises.writeFile(resolved, buffer);

      res.json({
        ok: true,
        savedPath: resolved,
        relativePath: path.relative(validatedProject, resolved),
        size: buffer.length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to upload file: ${message}` });
    }
  });

  /**
   * POST /api/files/move
   * Body: { projectPath: string, fromPath: string, toPath: string }
   *
   * Moves/renames a file or directory within the project root.
   */
  router.post("/move", async (req: Request, res: Response) => {
    const { projectPath, fromPath, toPath } = req.body as {
      projectPath?: string;
      fromPath?: string;
      toPath?: string;
    };

    if (!projectPath || !fromPath || !toPath) {
      res.status(400).json({ error: "Missing required fields: projectPath, fromPath, toPath" });
      return;
    }

    const validatedProject = validateProjectPath(projectPath);
    if (!validatedProject) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }

    const resolvedFrom = await resolveCreatableProjectPath(validatedProject, fromPath);
    const resolvedTo = await resolveCreatableProjectPath(validatedProject, toPath);
    if (!resolvedFrom || !resolvedTo) {
      res.status(403).json({ error: "Path escapes project root" });
      return;
    }

    try {
      await fs.promises.access(resolvedFrom);
      const dir = path.dirname(resolvedTo);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.rename(resolvedFrom, resolvedTo);

      res.json({
        ok: true,
        from: path.relative(validatedProject, resolvedFrom),
        to: path.relative(validatedProject, resolvedTo),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to move file: ${message}` });
    }
  });

  /**
   * DELETE /api/files/delete
   * Body: { projectPath: string, filePath: string }
   *
   * Deletes a file within the project root.
   */
  router.post("/delete", async (req: Request, res: Response) => {
    const { projectPath, filePath } = req.body as {
      projectPath?: string;
      filePath?: string;
    };

    if (!projectPath || !filePath) {
      res.status(400).json({ error: "Missing required fields: projectPath, filePath" });
      return;
    }

    const validatedProject = validateProjectPath(projectPath);
    if (!validatedProject) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }

    const resolved = await resolveCreatableProjectPath(validatedProject, filePath);
    if (!resolved) {
      res.status(403).json({ error: "Path escapes project root" });
      return;
    }

    try {
      await fs.promises.unlink(resolved);
      res.json({ ok: true, deleted: path.relative(validatedProject, resolved) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to delete file: ${message}` });
    }
  });

  /**
   * POST /api/files/mkdir
   * Body: { projectPath: string, dirPath: string }
   *
   * Creates a directory (and parents) within the project root.
   */
  router.post("/mkdir", async (req: Request, res: Response) => {
    const { projectPath, dirPath } = req.body as {
      projectPath?: string;
      dirPath?: string;
    };

    if (!projectPath || !dirPath) {
      res.status(400).json({ error: "Missing required fields: projectPath, dirPath" });
      return;
    }

    const validatedProject = validateProjectPath(projectPath);
    if (!validatedProject) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }

    const resolved = await resolveCreatableProjectPath(validatedProject, dirPath);
    if (!resolved) {
      res.status(403).json({ error: "Path escapes project root" });
      return;
    }

    try {
      await fs.promises.mkdir(resolved, { recursive: true });
      res.json({ ok: true, created: path.relative(validatedProject, resolved) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to create directory: ${message}` });
    }
  });

  return router;
}
