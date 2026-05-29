import type { Router } from "express";
import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  resolveExistingProjectPath,
  validateProjectPath,
} from "../../path-guard.ts";
import { decodePath, param } from "./helpers.ts";

/** Directories/files to always skip in listings */
const SKIP = new Set([
  "node_modules", ".git", ".next", ".cache", "dist", "build",
  ".turbo", ".vercel", ".DS_Store", "__pycache__", ".canvas-worktrees",
  ".canvas", "coverage", ".nyc_output", ".parcel-cache",
]);

/**
 * Best-effort extension → MIME mapping for the binary /blob endpoint.
 * Only the formats the client knows how to render — anything else falls
 * back to application/octet-stream and the client can decide what to do.
 */
const BLOB_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function mountFileRoutes(router: Router): void {
  // ── File read ────────────────────────────────────────
  router.get("/:encodedPath/file", async (req: Request, res: Response) => {
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

    const resolved = await resolveExistingProjectPath(projectPath, relFile);
    if (!resolved) {
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

  // ── Binary file read (for images and other non-text assets) ──
  // The /file endpoint above reads UTF-8 and is unsuitable for binary
  // content like PNG/JPEG. /blob streams the raw bytes with a best-effort
  // Content-Type so the client can wrap the response in a Blob/File and
  // hand it to the image-loader pipeline (downscale, decode, annotate).
  router.get("/:encodedPath/blob", async (req: Request, res: Response) => {
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

    const resolved = await resolveExistingProjectPath(projectPath, relFile);
    if (!resolved) {
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

    // Cap at 16MB. Images larger than this would be unusable on the
    // vision channel anyway — the client downscales to 1568px on load,
    // and 16MB of source is well above what any reasonable screenshot
    // or photo produces.
    const MAX_BLOB_SIZE = 16 * 1024 * 1024;
    if (stat.size > MAX_BLOB_SIZE) {
      res.status(413).json({ error: "File too large", size: stat.size, maxSize: MAX_BLOB_SIZE });
      return;
    }

    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mime = BLOB_MIME_TYPES[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(stat.size));
    // Stream the bytes directly. Using fs.createReadStream + pipe rather
    // than res.sendFile keeps us off the express/send middleware (which
    // adds its own caching and 404 handling we don't need here) and
    // avoids surprising response codes when the file is short-lived
    // (e.g. created in a test's beforeEach).
    const stream = fs.createReadStream(resolved);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  });

  // ── Directory listing (for file browser) ────────────
  router.get("/:encodedPath/ls", async (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const relDir = (req.query["path"] as string) || "";

    const resolved = await resolveExistingProjectPath(projectPath, relDir);
    if (!resolved) {
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
  router.get("/:encodedPath/tree", async (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const depthParam = req.query["depth"];
    const maxDepth = typeof depthParam === "string" ? Math.min(parseInt(depthParam, 10) || 2, 4) : 2;
    const rootPath = await resolveExistingProjectPath(projectPath, ".");
    if (!rootPath) {
      res.status(403).json({ error: "Path traversal not allowed" });
      return;
    }

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
      const tree = scanDir(rootPath, "", 0);
      res.json({ root: path.basename(projectPath), tree });
    } catch (err) {
      res.status(500).json({ error: "Failed to scan directory" });
    }
  });
}
