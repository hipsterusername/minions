import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join, basename, resolve, relative } from "node:path";

import type { WorktreeInfo, WorktreeLifecycle } from "./worktree-types.js";
import { exec, WORKTREE_DIR } from "./worktree-exec.js";

/**
 * Create a new git worktree + branch for a leader session.
 */
export async function createWorktree(
  projectPath: string,
  leaderSessionKey: string,
): Promise<WorktreeInfo> {
  const worktreeBase = join(projectPath, WORKTREE_DIR);
  await mkdir(worktreeBase, { recursive: true });
  const worktreePath = join(worktreeBase, leaderSessionKey);
  const branch = `canvas/${leaderSessionKey}`;
  await exec(["worktree", "add", worktreePath, "-b", branch], projectPath);
  return { path: worktreePath, branch, leaderSessionKey, createdAt: Date.now(),
    projectPath, lifecycle: "active" as WorktreeLifecycle };
}

export type PlannedWorktree = Omit<WorktreeInfo, "lifecycle"> & { lifecycle?: WorktreeLifecycle };

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
  startPoint = "HEAD"): Promise<WorktreeInfo> {
  const projectPath = resolve(plan.projectPath); const worktreePath = resolve(plan.path);
  const base = resolve(projectPath, WORKTREE_DIR); const rel = relative(base, worktreePath);
  if (!rel || rel.startsWith("..") || resolve(base, rel) !== worktreePath) {
    throw new Error("planned worktree path must be a child of the repository worktree directory");
  }
  const branch = plan.branch.startsWith("refs/heads/")
    ? plan.branch.slice("refs/heads/".length) : plan.branch;
  await exec(["check-ref-format", "--branch", branch], projectPath);
  await mkdir(base, { recursive: true });
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
  const worktreeBase = join(projectPath, WORKTREE_DIR);

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

    // Only include worktrees under .canvas-worktrees
    if (path && path.startsWith(worktreeBase)) {
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

  const worktreeBase = join(projectPath, WORKTREE_DIR);
  let entries: string[];
  try {
    entries = await readdir(worktreeBase);
  } catch {
    // Directory doesn't exist — nothing to clean.
    return;
  }

  for (const entry of entries) {
    const entryPath = join(worktreeBase, entry);
    try {
      // rmdir only succeeds on empty directories.
      await rmdir(entryPath);
    } catch {
      // Not empty or not a directory — skip.
    }
  }
}
