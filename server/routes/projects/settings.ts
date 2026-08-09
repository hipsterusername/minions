import type { Router } from "express";
import type { Request, Response } from "express";
import {
  readContext,
  writeContext,
  readSettings,
  writeSettings,
  readSkills,
  writeSkills,
} from "../../project-store.ts";
import type { ProjectSettings } from "../../project-store.ts";
import {
  listMcpServers,
  saveMcpServer,
  deleteMcpServer,
} from "../../mcp-server-store.ts";
import { validateProjectPath } from "../../path-guard.ts";
import { decodePath, param } from "./helpers.ts";

export function mountSettingsRoutes(router: Router): void {
  // ── Context.md routes ────────────────────────────────

  router.get("/:encodedPath/context", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    res.json(readContext(projectPath));
  });

  router.put("/:encodedPath/context", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const { content } = req.body as { content: string };
    writeContext(projectPath, content);
    res.json({ ok: true });
  });

  // ── Settings routes ──────────────────────────────────

  router.get("/:encodedPath/settings", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    res.json(readSettings(projectPath));
  });

  router.put("/:encodedPath/settings", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const settings = req.body as ProjectSettings;
    writeSettings(projectPath, settings);
    res.json({ ok: true });
  });

  // ── Skills routes ───────────────────────────────────

  router.get("/:encodedPath/skills", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    res.json(readSkills(projectPath));
  });

  router.put("/:encodedPath/skills", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    const skills = req.body as unknown[];
    if (!Array.isArray(skills)) {
      res.status(400).json({ error: "Expected an array of skills" });
      return;
    }
    writeSkills(projectPath, skills);
    res.json({ ok: true });
  });

  // ── MCP server routes ───────────────────────────────────

  router.get("/:encodedPath/mcp-servers", (req: Request, res: Response) => {
    const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
    if (!projectPath) {
      res.status(403).json({ error: "Project path not registered or outside home directory" });
      return;
    }
    res.json(listMcpServers(projectPath));
  });

  router.put(
    "/:encodedPath/mcp-servers/:serverId",
    (req: Request, res: Response) => {
      const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
      if (!projectPath) {
        res.status(403).json({ error: "Project path not registered or outside home directory" });
        return;
      }
      try {
        const entry = saveMcpServer(projectPath, req.body as Parameters<typeof saveMcpServer>[1]);
        res.json(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    },
  );

  router.delete(
    "/:encodedPath/mcp-servers/:serverId",
    (req: Request, res: Response) => {
      const projectPath = validateProjectPath(decodePath(param(req, "encodedPath")));
      if (!projectPath) {
        res.status(403).json({ error: "Project path not registered or outside home directory" });
        return;
      }
      const serverId = param(req, "serverId");
      const removed = deleteMcpServer(projectPath, serverId);
      if (!removed) {
        res.status(404).json({ error: `MCP server "${serverId}" not found` });
        return;
      }
      res.json({ ok: true });
    },
  );
}
