import path from "path";
import os from "os";
import fs from "fs";
import { canonicalizeSourceRoot } from "./workspace-registry.ts";

/**
 * Path validation module to prevent arbitrary filesystem access.
 *
 * Maintains a server-side allowlist of "opened" project paths.
 * Only paths that have been explicitly opened/created via the projects API
 * are allowed for subsequent operations.
 *
 * ## Durability model
 *
 * The allowlist is process-scoped (an in-memory Set), but is durably derived:
 * on startup, call `rehydrateFromPaths` with the persisted recent-projects list
 * to restore the allowlist across server restarts. The route layer in
 * `server/routes/projects/core.ts` does this as part of `mountCoreRoutes`.
 *
 * Invariant: every path in `openedProjects` is an absolute canonical source
 * root. Registration is the authorization act; mounted-volume location is not.
 *
 * ## Threat model
 *
 * This module guards against API callers supplying arbitrary filesystem paths
 * (e.g. unregistered roots and path-traversal tricks) to read or write outside
 * an opened project. It is NOT a multi-user or remote-network security
 * boundary — the server is local-only and single-user. A persistent ACL in a
 * The durable UUID workspace registry and recent-project index are restored by
 * the route layer; this module keeps only the active process allowlist.
 */

const openedProjects = new Set<string>();

const HOME_DIR = os.homedir();

function isInsideOrEqual(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function realpathOrNull(absPath: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(absPath);
  } catch {
    return null;
  }
}

async function lstatOrNull(absPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(absPath);
  } catch {
    return null;
  }
}

async function closestExistingAncestor(absPath: string, boundary: string): Promise<string | null> {
  let current = absPath;
  while (isInsideOrEqual(boundary, current)) {
    const stat = await lstatOrNull(current);
    if (stat) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Check if a path is under the user's home directory.
 * Rejects paths like /etc, /usr, /var, etc.
 */
export function isUnderHomeDir(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  return resolved.startsWith(HOME_DIR + path.sep) || resolved === HOME_DIR;
}

/**
 * Validate and register a project path.
 * Returns the resolved absolute path if valid, or null if rejected.
 * Call this when creating/opening a project.
 */
export function registerProjectPath(projectPath: string): string | null {
  const canonical = canonicalizeSourceRoot(path.resolve(projectPath));
  if (!canonical) return null;
  openedProjects.add(canonical);
  return canonical;
}

/**
 * Check if a path is a registered (opened) project path.
 */
export function isRegisteredProject(projectPath: string): boolean {
  const canonical = canonicalizeSourceRoot(path.resolve(projectPath));
  return canonical !== null && openedProjects.has(canonical);
}

/**
 * Validate that a path is a registered project.
 * Returns resolved path or null.
 */
export function validateProjectPath(projectPath: string): string | null {
  const canonical = canonicalizeSourceRoot(path.resolve(projectPath));
  if (!canonical || !openedProjects.has(canonical)) {
    return null;
  }
  return canonical;
}

/**
 * Remove a project from the registered set.
 */
export function unregisterProjectPath(projectPath: string): void {
  const canonical = canonicalizeSourceRoot(path.resolve(projectPath));
  if (canonical) openedProjects.delete(canonical);
}

/**
 * Bulk-register project paths from durable storage (e.g. the recent-projects list).
 * Call once at startup to restore the allowlist across server restarts.
 *
 * Invalid or unresolvable paths are silently skipped. Stale entries remain
 * inaccessible until explicitly opened again.
 */
export function rehydrateFromPaths(paths: readonly string[]): void {
  for (const p of paths) {
    registerProjectPath(p); // returns null for invalid paths — intentional no-op
  }
}

/**
 * Validate a CWD for session creation.
 * Must be an explicitly registered canonical source root.
 */
export function validateSessionCwd(cwd: string): string | null {
  const resolved = path.resolve(cwd);
  const real = (() => {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return null;
    }
  })();
  if (!real) return null;

  for (const project of openedProjects) {
    let projectReal: string;
    try {
      projectReal = fs.realpathSync(project);
    } catch {
      continue;
    }
    if (real === projectReal) return real;
  }
  return null;
}

/** Validate a session CWD against registered projects or registry-owned active worktrees. */
export function validateOwnedSessionCwd(
  cwd: string,
  activeWorktreePaths: readonly string[],
): string | null {
  const project = validateSessionCwd(cwd);
  if (project) return project;

  let real: string;
  try {
    real = fs.realpathSync(path.resolve(cwd));
  } catch {
    return null;
  }
  for (const worktreePath of activeWorktreePaths) {
    try {
      if (fs.realpathSync(path.resolve(worktreePath)) === real) return real;
    } catch {
      // A stale or concurrently removed worktree is not an allowed CWD.
    }
  }
  return null;
}

/**
 * Resolve an existing project-relative path and verify its final realpath stays
 * inside the real project root. This is appropriate for read/list operations,
 * where following a symlink is acceptable only when it lands inside the project.
 */
export async function resolveExistingProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, relativePath);
  if (!isInsideOrEqual(root, candidate)) {
    return null;
  }

  const [rootReal, targetReal] = await Promise.all([
    realpathOrNull(root),
    realpathOrNull(candidate),
  ]);
  if (!rootReal) {
    return null;
  }
  if (!targetReal) {
    return candidate;
  }
  if (!isInsideOrEqual(rootReal, targetReal)) {
    return null;
  }

  return candidate;
}

/**
 * Resolve a project-relative path for write-like operations. The final path may
 * not exist yet, so validation is anchored on the closest existing parent. A
 * symlink final target is rejected to avoid mutating through links.
 */
export async function resolveCreatableProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, relativePath);
  if (!isInsideOrEqual(root, candidate)) {
    return null;
  }

  const rootReal = await realpathOrNull(root);
  if (!rootReal) {
    return null;
  }

  const finalStat = await lstatOrNull(candidate);
  if (finalStat?.isSymbolicLink()) {
    return null;
  }

  const ancestor = await closestExistingAncestor(path.dirname(candidate), root);
  if (!ancestor) {
    return null;
  }

  const ancestorReal = await realpathOrNull(ancestor);
  if (!ancestorReal || !isInsideOrEqual(rootReal, ancestorReal)) {
    return null;
  }

  return candidate;
}
