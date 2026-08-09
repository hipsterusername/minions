import { Router } from "express";
import type { Request, Response } from "express";
import { getHarnessReadiness } from "../harness/readiness.ts";

export function createReadinessRoutes(): Router {
  const router = Router();
  router.get("/", async (req: Request, res: Response) => {
    const snapshot = await getHarnessReadiness({ fresh: req.query["refresh"] === "1" });
    res.json(snapshot);
  });
  return router;
}
