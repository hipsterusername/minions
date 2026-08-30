import type { Request, Response, Router } from "express";

import { initializeProjectGit, inspectProjectGit } from "../../project-git.ts";
import { canonicalizeSourceRoot } from "../../workspace-registry.ts";

export type ProjectGitAction = "initialize" | "continue_without_git";

export interface ProjectGitDependencies {
  inspectProjectGit: (projectPath: string) => { isRepository: boolean };
  initializeProjectGit: (projectPath: string) => void | Promise<void>;
}

const defaultDependencies: ProjectGitDependencies = { inspectProjectGit, initializeProjectGit };

function validGitAction(value: unknown): value is ProjectGitAction {
  return value === "initialize" || value === "continue_without_git";
}

export function mountProjectGitRoutes(
  router: Router,
  deps: ProjectGitDependencies = defaultDependencies,
): void {
  router.post("/git-status", (req: Request, res: Response) => {
    const projectPath = (req.body as { path?: unknown }).path;
    if (typeof projectPath !== "string") {
      res.status(400).json({ error: "Project path is required" });
      return;
    }
    const canonicalPath = canonicalizeSourceRoot(projectPath);
    if (!canonicalPath) {
      res.status(403).json({ error: "Project path must be an absolute canonical source root" });
      return;
    }
    res.json(deps.inspectProjectGit(canonicalPath));
  });
}

export function ensureProjectGitReady(
  res: Response,
  projectPath: string,
  action: unknown,
  deps: ProjectGitDependencies = defaultDependencies,
): boolean | Promise<boolean> {
  if (action !== undefined && !validGitAction(action)) {
    res.status(400).json({ error: "Invalid Git initialization action" });
    return false;
  }

  const status = deps.inspectProjectGit(projectPath);
  if (status.isRepository) return true;
  if (action === undefined) {
    res.status(409).json({
      code: "GIT_CONFIRMATION_REQUIRED",
      gitStatus: status,
      warning: "Minions may run into issues in projects that are not Git repositories.",
    });
    return false;
  }
  if (action === "continue_without_git") return true;

  const fail = (error: unknown): false => {
    const message = error instanceof Error ? error.message : "Git initialization failed";
    res.status(500).json({ code: "GIT_INITIALIZATION_FAILED", error: message });
    return false;
  };
  try {
    const result = deps.initializeProjectGit(projectPath);
    return result instanceof Promise ? result.then(() => true).catch(fail) : true;
  } catch (error) {
    return fail(error);
  }
}
