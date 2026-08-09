import path from "node:path";
import { findWorkspaceBySource } from "./workspace-registry.ts";
import { WORKTREE_DIR } from "./worktree-exec.ts";

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Preferred Minions-owned execution root for a registered repository. */
export function ownedWorktreeRoot(projectPath: string): string {
  const workspace = findWorkspaceBySource(projectPath);
  return workspace
    ? path.join(workspace.stateRoot, "worktrees")
    : path.join(path.resolve(projectPath), WORKTREE_DIR);
}

/** Current central root plus the legacy in-repository root during migration. */
export function allowedWorktreeRoots(projectPath: string): string[] {
  const preferred = ownedWorktreeRoot(projectPath);
  const legacy = path.join(path.resolve(projectPath), WORKTREE_DIR);
  return preferred === legacy ? [preferred] : [preferred, legacy];
}

export function isOwnedWorktreePath(projectPath: string, candidate: string): boolean {
  return allowedWorktreeRoots(projectPath).some((root) => contains(root, candidate));
}
