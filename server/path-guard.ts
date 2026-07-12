import path from "path";
import os from "os";
import fs from "fs";

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
 * Invariant: every path in `openedProjects` was validated against `isUnderHomeDir`
 * at registration time, so the Set is always a subset of paths under $HOME.
 *
 * ## Threat model
 *
 * This module guards against API callers supplying arbitrary filesystem paths
 * (e.g. `/etc/passwd`, path-traversal tricks) to read or write outside the
 * user's home directory. It is NOT a multi-user or remote-network security
 * boundary — the server is local-only and single-user. A persistent ACL in a
 * database would add write-ordering complexity with no meaningful security gain
 * for this threat model; the JSON-backed recent-projects list is sufficient
 * durable storage.
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
  const resolved = path.resolve(projectPath);

  // Must be under home directory
  if (!isUnderHomeDir(resolved)) {
    return null;
  }

  try {
    const real = fs.realpathSync(resolved);
    if (!isUnderHomeDir(real)) {
      return null;
    }
  } catch {
    // Projects can be registered before their directories exist; callers that
    // perform filesystem operations validate the real project root later.
  }

  // Reject paths with .. components after resolution (already resolved, but extra safety)
  if (resolved.includes("..")) {
    return null;
  }

  openedProjects.add(resolved);
  return resolved;
}

/**
 * Check if a path is a registered (opened) project path.
 */
export function isRegisteredProject(projectPath: string): boolean {
  const resolved = path.resolve(projectPath);
  return openedProjects.has(resolved);
}

/**
 * Validate that a path is a registered project.
 * Returns resolved path or null.
 */
export function validateProjectPath(projectPath: string): string | null {
  const resolved = path.resolve(projectPath);
  if (!openedProjects.has(resolved)) {
    return null;
  }
  return resolved;
}

/**
 * Remove a project from the registered set.
 */
export function unregisterProjectPath(projectPath: string): void {
  openedProjects.delete(path.resolve(projectPath));
}

/**
 * Bulk-register project paths from durable storage (e.g. the recent-projects list).
 * Call once at startup to restore the allowlist across server restarts.
 *
 * Invalid paths (outside home directory) are silently skipped — the durable
 * store may contain stale entries for paths that have since been moved or
 * deleted. Those paths will simply remain inaccessible until re-opened.
 */
export function rehydrateFromPaths(paths: readonly string[]): void {
  for (const p of paths) {
    registerProjectPath(p); // returns null for invalid paths — intentional no-op
  }
}

/**
 * Validate a CWD for session creation.
 * Must be under home directory.
 */
export function validateSessionCwd(cwd: string): string | null {
  const resolved = path.resolve(cwd);
  if (!isUnderHomeDir(resolved)) return null;

  const real = (() => {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return null;
    }
  })();
  if (!real || !isUnderHomeDir(real)) return null;

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
  if (!isUnderHomeDir(real)) return null;

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
  if (!rootReal || !isUnderHomeDir(rootReal)) {
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
  if (!rootReal || !isUnderHomeDir(rootReal)) {
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
