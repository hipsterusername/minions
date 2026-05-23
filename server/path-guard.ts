import path from "path";
import os from "os";

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
  if (!isUnderHomeDir(resolved)) {
    return null;
  }
  return resolved;
}
