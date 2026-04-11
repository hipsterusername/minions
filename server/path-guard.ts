import path from "path";
import os from "os";

/**
 * Path validation module to prevent arbitrary filesystem access.
 *
 * Maintains a server-side set of "opened" project paths.
 * Only paths that have been explicitly opened/created via the projects API
 * are allowed for subsequent operations.
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
