import { Router } from "express";
import { mountCoreRoutes } from "./projects/core.ts";
import { mountSettingsRoutes } from "./projects/settings.ts";
import { mountFileRoutes } from "./projects/files.ts";
import { mountRoutinesRoutes } from "./projects/routines.ts";

// ── Routes ───────────────────────────────────────────────

export function createProjectRoutes(): Router {
  const router = Router();

  mountCoreRoutes(router);
  mountSettingsRoutes(router);
  mountFileRoutes(router);
  mountRoutinesRoutes(router);

  return router;
}
