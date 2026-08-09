import fs from "node:fs";
import path from "node:path";
import { canonicalizeSourceRoot, findWorkspaceBySource } from "./workspace-registry.ts";
import { WORKTREE_DIR } from "./worktree-exec.ts";

function lexicallyContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function existingPathIsReal(target: string): boolean {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      // The owned root itself must not be a symlink. Its already-existing
      // ancestors may be benign platform aliases (for example macOS
      // /var -> /private/var), so do not require lexical === realpath here.
      return stat.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

function containsWithoutSymlinks(root: string, candidate: string): boolean {
  if (!lexicallyContains(root, candidate) || !existingPathIsReal(root)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

/** Preferred Minions-owned execution root for a registered repository. */
export function ownedWorktreeRoot(projectPath: string): string {
  const workspace = findWorkspaceBySource(projectPath);
  const sourceRoot = canonicalizeSourceRoot(projectPath) ?? path.resolve(projectPath);
  return workspace
    ? path.join(workspace.stateRoot, "worktrees")
    : path.join(sourceRoot, WORKTREE_DIR);
}

/** Current central root plus the legacy in-repository root during migration. */
export function allowedWorktreeRoots(projectPath: string): string[] {
  const preferred = ownedWorktreeRoot(projectPath);
  const sourceRoot = canonicalizeSourceRoot(projectPath) ?? path.resolve(projectPath);
  const legacy = path.join(sourceRoot, WORKTREE_DIR);
  return preferred === legacy ? [preferred] : [preferred, legacy];
}

/** True only when an owned root itself is not a symlink (or beneath one). */
export function isSafeOwnedWorktreeRoot(root: string): boolean {
  return existingPathIsReal(root);
}

export function isOwnedWorktreePath(projectPath: string, candidate: string): boolean {
  return allowedWorktreeRoots(projectPath).some((root) => containsWithoutSymlinks(root, candidate));
}
