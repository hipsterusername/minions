/**
 * REST endpoints for per-project routine CRUD.
 *
 * Routes (relative to the parent router mount point):
 *   GET    /:encodedPath/routines                — list all routines
 *   GET    /:encodedPath/routines/:routineId     — load one routine
 *   PUT    /:encodedPath/routines/:routineId     — save (upsert) a routine
 *   DELETE /:encodedPath/routines/:routineId     — remove a routine
 *
 * Validation is delegated to `safeParseRoutine` + `findDuplicateIds` from
 * the shared schema so the store layer never sees an invalid payload.
 */

import type { Router } from "express";
import type { Request, Response } from "express";
import { validateProjectPath } from "../../path-guard.ts";
import { decodePath, param } from "./helpers.ts";
import {
  listRoutines,
  loadRoutineByIdStrict,
  saveRoutine,
  deleteRoutine,
} from "../../routine-store.ts";
import {
  safeParseRoutine,
  findDuplicateIds,
} from "../../../shared/routines/types.ts";

function guardProject(req: Request, res: Response): string | null {
  const projectPath = validateProjectPath(
    decodePath(param(req, "encodedPath")),
  );
  if (!projectPath) {
    res
      .status(403)
      .json({ error: "Project path not registered or outside home directory" });
    return null;
  }
  return projectPath;
}

export function mountRoutinesRoutes(router: Router): void {
  // GET /:encodedPath/routines — list all routines for a project
  router.get("/:encodedPath/routines", (req: Request, res: Response) => {
    const projectPath = guardProject(req, res);
    if (!projectPath) return;
    res.json(listRoutines(projectPath));
  });

  // GET /:encodedPath/routines/:routineId — fetch one routine
  router.get(
    "/:encodedPath/routines/:routineId",
    (req: Request, res: Response) => {
      const projectPath = guardProject(req, res);
      if (!projectPath) return;

      const routineId = param(req, "routineId");
      const result = loadRoutineByIdStrict(projectPath, routineId);
      if (!result.ok) {
        const status = result.reason === "missing" ? 404 : 422;
        res.status(status).json({
          error: result.reason,
          errors: result.errors ?? [],
        });
        return;
      }
      res.json(result.routine);
    },
  );

  // PUT /:encodedPath/routines/:routineId — save (upsert) a routine
  router.put(
    "/:encodedPath/routines/:routineId",
    (req: Request, res: Response) => {
      const projectPath = guardProject(req, res);
      if (!projectPath) return;

      const parsed = safeParseRoutine(req.body);
      if (!parsed.ok) {
        res.status(422).json({ error: "schema", errors: parsed.errors });
        return;
      }

      const dups = findDuplicateIds(parsed.routine);
      if (dups.length > 0) {
        res.status(422).json({
          error: "duplicate-ids",
          errors: dups.map((d) => ({ path: d, message: "duplicate id" })),
        });
        return;
      }

      try {
        const saved = saveRoutine(projectPath, parsed.routine);
        res.json(saved);
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : "save failed" });
      }
    },
  );

  // DELETE /:encodedPath/routines/:routineId — remove a routine
  router.delete(
    "/:encodedPath/routines/:routineId",
    (req: Request, res: Response) => {
      const projectPath = guardProject(req, res);
      if (!projectPath) return;

      const routineId = param(req, "routineId");
      const removed = deleteRoutine(projectPath, routineId);
      if (!removed) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ ok: true });
    },
  );
}
