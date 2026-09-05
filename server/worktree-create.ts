import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";

import type { WorktreeInfo, WorktreeLifecycle } from "./worktree-types.js";
import { exec } from "./worktree-exec.js";
import {
  allowedWorktreeRoots,
  isOwnedWorktreePath,
  isSafeOwnedWorktreeRoot,
  ownedWorktreeRoot,
} from "./worktree-owned-root.ts";

/**
 * Create a new git worktree + branch for a leader session.
 */
export async function createWorktree(
  projectPath: string,
  leaderSessionKey: string,
): Promise<WorktreeInfo> {
  const worktreeBase = ownedWorktreeRoot(projectPath);
  const worktreePath = join(worktreeBase, leaderSessionKey);
  if (!isOwnedWorktreePath(projectPath, worktreePath)) {
    throw new Error("refusing to create a worktree outside a real Minions-owned root");
  }
  await mkdir(worktreeBase, { recursive: true });
  if (!isSafeOwnedWorktreeRoot(worktreeBase)
    || !isOwnedWorktreePath(projectPath, worktreePath)) {
    throw new Error("refusing to create a worktree beneath a symlinked root");
  }
  const branch = `canvas/${leaderSessionKey}`;
  await exec(["worktree", "add", worktreePath, "-b", branch], projectPath);
  return { path: worktreePath, branch, leaderSessionKey, createdAt: Date.now(),
    projectPath, lifecycle: "active" as WorktreeLifecycle };
}

export type PlannedWorktree = Omit<WorktreeInfo, "lifecycle"> & { lifecycle?: WorktreeLifecycle; baseSha?: string };

export async function resolveWorktreeBase(projectPath: string,
  targetRef?: string): Promise<{ targetRef: string; baseSha: string }> {
  const resolvedTarget = targetRef ?? (await exec(
    ["symbolic-ref", "--quiet", "--short", "HEAD"], projectPath)).stdout.trim();
  const ref = resolvedTarget.startsWith("refs/") ? resolvedTarget : `refs/heads/${resolvedTarget}`;
  await exec(["check-ref-format", ref], projectPath);
  const baseSha = (await exec(["rev-parse", ref], projectPath)).stdout.trim();
  return { targetRef: ref, baseSha };
}

/** Provision or idempotently reuse an exact persisted contribution identity. */
export async function provisionPlannedWorktree(plan: PlannedWorktree,
  startPoint = plan.baseSha ?? "HEAD"): Promise<WorktreeInfo> {
  const projectPath = resolve(plan.projectPath); const worktreePath = resolve(plan.path);
  const base = allowedWorktreeRoots(projectPath)
    .find((root) => isOwnedWorktreePath(projectPath, worktreePath)
      && worktreePath.startsWith(`${resolve(root)}${sep}`));
  if (!base) {
    throw new Error("planned worktree path must be a child of a Minions-owned worktree root");
  }
  const branch = plan.branch.startsWith("refs/heads/")
    ? plan.branch.slice("refs/heads/".length) : plan.branch;
  await exec(["check-ref-format", "--branch", branch], projectPath);
  await mkdir(base, { recursive: true });
  if (!isSafeOwnedWorktreeRoot(base) || !isOwnedWorktreePath(projectPath, worktreePath)) {
    throw new Error("planned worktree root became unsafe during provisioning");
  }
  try {
    const { stdout } = await exec(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
    if (stdout.trim() !== branch) throw new Error(
      `planned worktree path is already attached to ${stdout.trim()}, expected ${branch}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already attached")) throw error;
    let branchExists = true;
    try { await exec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], projectPath); }
    catch { branchExists = false; }
    await exec(branchExists
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", worktreePath, "-b", branch, startPoint], projectPath);
  }
  if (plan.baseSha) {
    try { await exec(["merge-base", "--is-ancestor", plan.baseSha, "HEAD"], worktreePath); }
    catch { throw new Error("Contribution checkout does not contain its recorded base; preserve its edits and repair the branch before resuming"); }
  }
  return { ...plan, branch, path: worktreePath, projectPath, lifecycle: "active" };
}

/**
 * Force-remove a worktree and delete its branch.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectPath  - Absolute path to the main project root (avoids fragile `../..` derivation)
 */
export async function removeWorktree(worktreePath: string, projectPath?: string,
  persistedBranch?: string): Promise<void> {
  // Derive the branch name from the worktree directory name.
  const key = basename(worktreePath);
  const branch = persistedBranch?.startsWith("refs/heads/")
    ? persistedBranch.slice("refs/heads/".length)
    : persistedBranch ?? `canvas/${key}`;

  // Use explicit projectPath if provided, otherwise fall back to derivation.
  const resolvedProjectPath = projectPath ?? join(worktreePath, "..", "..");
  if (!isOwnedWorktreePath(resolvedProjectPath, worktreePath)) {
    throw new Error("refusing to remove a worktree outside Minions-owned roots");
  }

  await exec(["worktree", "remove", "--force", worktreePath], resolvedProjectPath);
  await exec(["branch", "-D", branch], resolvedProjectPath);
}

/**
 * List active canvas worktrees for a project.
 */
export async function listWorktrees(
  projectPath: string,
): Promise<WorktreeInfo[]> {
  const { stdout } = await exec(["worktree", "list", "--porcelain"], projectPath);
  const results: WorktreeInfo[] = [];

  // Porcelain output is blocks separated by blank lines.
  // Each block has lines like:
  //   worktree /path/to/wt
  //   HEAD abc123
  //   branch refs/heads/canvas/key
  const blocks = stdout.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let branch = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace("refs/heads/", "");
      }
    }

    // Include central registry-owned worktrees and legacy in-repository ones.
    if (path && isOwnedWorktreePath(projectPath, path)) {
      const key = basename(path);
      results.push({
        path,
        branch,
        leaderSessionKey: key,
        createdAt: 0, // Not tracked by git; caller can enrich from DB
        projectPath,
        lifecycle: "active",
      });
    }
  }

  return results;
}

/**
 * Check if a path is inside a git repository.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await exec(["rev-parse", "--git-dir"], path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prune stale worktree references and remove empty directories
 * under `.canvas-worktrees`.
 */
export async function cleanupStaleWorktrees(
  projectPath: string,
): Promise<void> {
  await exec(["worktree", "prune"], projectPath);

  for (const worktreeBase of allowedWorktreeRoots(projectPath)) {
    if (!isSafeOwnedWorktreeRoot(worktreeBase)) continue;
    let entries: string[];
    try {
      entries = await readdir(worktreeBase);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(worktreeBase, entry);
      if (!isOwnedWorktreePath(projectPath, entryPath)) continue;
      try {
        // rmdir only succeeds on empty directories.
        await rmdir(entryPath);
      } catch {
        // Not empty or not a directory — skip.
      }
    }
  }
}
