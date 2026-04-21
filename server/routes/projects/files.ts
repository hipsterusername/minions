import type { Router } from "express";
import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { validateProjectPath } from "../../path-guard.ts";
import { decodePath, param } from "./helpers.ts";

/** Directories/files to always skip in listings */
const SKIP = new Set([
  "node_modules", ".git", ".next", ".cache", "dist", "build",
  ".turbo", ".vercel", ".DS_Store", "__pycache__", ".canvas-worktrees",
  ".canvas", "coverage", ".nyc_output", ".parcel-cache",
]);

export function mountFileRoutes(router: Router): void {
  // ── File read ────────────────────────────────────────
  router.get("/:encodedPath/file", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const relFile = req.query["path"];

    if (typeof relFile !== "string" || !relFile) {
      res.status(400).json({ error: "Missing ?path= query parameter" });
      return;
    }

    // Prevent path traversal
    const resolved = path.resolve(projectPath, relFile);
    if (!resolved.startsWith(projectPath + path.sep) && resolved !== projectPath) {
      res.status(403).json({ error: "Path traversal not allowed" });
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      res.status(400).json({ error: "Not a file" });
      return;
    }

    // Cap at 512KB to avoid huge payloads
    const MAX_SIZE = 512 * 1024;
    if (stat.size > MAX_SIZE) {
      res.json({
        path: relFile,
        size: stat.size,
        truncated: true,
        content: fs.readFileSync(resolved, "utf-8").slice(0, MAX_SIZE),
      });
      return;
    }

    try {
      const content = fs.readFileSync(resolved, "utf-8");
      res.json({ path: relFile, size: stat.size, truncated: false, content });
    } catch {
      res.status(500).json({ error: "Failed to read file" });
    }
  });

  // ── Directory listing (for file browser) ────────────
  router.get("/:encodedPath/ls", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const relDir = (req.query["path"] as string) || "";

    const resolved = path.resolve(projectPath, relDir);
    if (!resolved.startsWith(projectPath + path.sep) && resolved !== projectPath) {
      res.status(403).json({ error: "Path traversal not allowed" });
      return;
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !SKIP.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => ({ name: e.name, type: "dir" as const }));
      const files = entries
        .filter(e => e.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => {
          const size = fs.statSync(path.join(resolved, e.name)).size;
          return { name: e.name, type: "file" as const, size };
        });
      res.json({ path: relDir, entries: [...dirs, ...files] });
    } catch {
      res.status(500).json({ error: "Failed to list directory" });
    }
  });

  // ── Directory tree (high-level) ──────────────────────
  router.get("/:encodedPath/tree", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const depthParam = req.query["depth"];
    const maxDepth = typeof depthParam === "string" ? Math.min(parseInt(depthParam, 10) || 2, 4) : 2;

    interface TreeNode {
      name: string;
      path: string;       // relative to project root
      type: "dir" | "file";
      children?: TreeNode[];
    }

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
}
