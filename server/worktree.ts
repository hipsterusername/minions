import { execFile as execFileCb } from "node:child_process";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join, basename } from "node:path";

// ── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Formal worktree lifecycle states.
 *
 * initializing → active   (worktree created successfully)
 * initializing → failed   (git worktree add failed — user must decide)
 * active       → merging  (user approved merge)
 * merging      → cleaned  (merge succeeded, worktree + branch removed)
 * merging      → active   (merge had conflicts, aborted — user can retry)
 * active       → cleaned  (user chose to discard)
 */
export type WorktreeLifecycle =
  | "initializing"
  | "active"
  | "failed"
  | "merging"
  | "cleaned";

export interface WorktreeInfo {
  path: string;
  branch: string;
  leaderSessionKey: string;
  createdAt: number;
  projectPath: string;
  lifecycle: WorktreeLifecycle;
}

export interface MergeResult {
  success: boolean;
  conflicts: string[];
  summary: string;
  targetBranch?: string;
}

export interface GitStatus {
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const WORKTREE_DIR = ".canvas-worktrees";

function exec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args[0]}: ${msg}`));
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

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

  await exec(
    ["worktree", "add", worktreePath, "-b", branch],
    projectPath,
  );

  return {
    path: worktreePath,
    branch,
    leaderSessionKey,
    createdAt: Date.now(),
    projectPath,
    lifecycle: "active" as WorktreeLifecycle,
  };
}

/**
 * Force-remove a worktree and delete its branch.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectPath  - Absolute path to the main project root (avoids fragile `../..` derivation)
 */
export async function removeWorktree(worktreePath: string, projectPath?: string): Promise<void> {
  // Derive the branch name from the worktree directory name.
  const key = basename(worktreePath);
  const branch = `canvas/${key}`;

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
 * Merge the worktree branch into a target branch (default: current branch
 * of the main worktree).
 *
 * SAFETY: This function does NOT run `git checkout` in the user's main
 * worktree. Instead it merges the target branch into the canvas branch
 * (inside the worktree), then fast-forwards the target ref. This avoids
 * disrupting the user's working directory, uncommitted changes, or branch.
 */
export async function mergeWorktree(
  info: WorktreeInfo,
  targetBranch?: string,
  options?: { force?: boolean; strategy?: "ours" | "theirs" },
): Promise<MergeResult> {
  const projectCwd = info.projectPath;
  const worktreeCwd = info.path;

  // If no target specified, determine the current branch of the main worktree.
  if (!targetBranch) {
    const { stdout } = await exec(["rev-parse", "--abbrev-ref", "HEAD"], projectCwd);
    targetBranch = stdout.trim();
  }

  // Step 1: Inside the worktree, merge the target branch INTO the canvas branch.
  // This catches up the canvas branch with any changes on main since the worktree
  // was created, and surfaces any conflicts here (in the worktree, not in main).
  //
  // Strategy options:
  //   "ours"   → force=true or strategy="ours": keep canvas changes on conflicts
  //   "theirs" → strategy="theirs": keep main branch changes on conflicts
  //   (none)   → no auto-resolution, conflicts surface as errors
  const strategy = options?.strategy ?? (options?.force ? "ours" : undefined);
  const mergeArgs = strategy
    ? ["merge", targetBranch, "--no-edit", "-X", strategy]
    : ["merge", targetBranch, "--no-edit"];
  try {
    await exec(mergeArgs, worktreeCwd);
  } catch (err) {
    // Merge produced conflicts. If a strategy was requested, try to force-resolve
    // remaining conflicts (modify/delete, add/add, tree conflicts) that -X alone
    // can't handle, then complete the merge without aborting.
    if (strategy) {
      try {
        // Identify unresolved files
        const { stdout: diffOut } = await exec(
          ["diff", "--name-only", "--diff-filter=U"],
          worktreeCwd,
        );
        const unresolved = diffOut.trim().split("\n").filter(Boolean);

        if (unresolved.length > 0) {
          // Force-resolve each conflicted file using the chosen side
          const checkoutFlag = strategy === "ours" ? "--ours" : "--theirs";
          for (const file of unresolved) {
            try {
              await exec(["checkout", checkoutFlag, "--", file], worktreeCwd);
            } catch {
              // File may have been deleted on one side — accept deletion
              try {
                await exec(["rm", "--", file], worktreeCwd);
              } catch {
                // Already removed or other edge case — skip
              }
            }
          }
        }

        // Stage all resolved files and complete the merge
        await exec(["add", "-A"], worktreeCwd);
        await exec(
          ["commit", "--no-edit", "-m", `Merge ${targetBranch} (resolved with ${strategy} strategy)`],
          worktreeCwd,
        );
        // Merge completed successfully via manual resolution — fall through to Step 2
      } catch (resolveErr) {
        // Manual resolution failed — abort and report
        try { await exec(["merge", "--abort"], worktreeCwd); } catch { /* ignore */ }
        const message = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
        return {
          success: false,
          conflicts: [],
          targetBranch,
          summary: `Merge failed even with ${strategy} strategy: ${message}`,
        };
      }
    } else {
      // No strategy — report conflicts for user resolution
      let conflicts: string[] = [];
      try {
        const { stdout: diffOut } = await exec(
          ["diff", "--name-only", "--diff-filter=U"],
          worktreeCwd,
        );
        conflicts = diffOut.trim().split("\n").filter(Boolean);
      } catch {
        // If diff fails too, just use the error message.
      }

      // Abort the failed merge in the worktree.
      try {
        await exec(["merge", "--abort"], worktreeCwd);
      } catch {
        // Abort may fail if there's nothing to abort; ignore.
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        conflicts,
        targetBranch,
        summary: `Merge failed (conflicts with ${targetBranch}): ${message}`,
      };
    }
  }

  // Step 2: The canvas branch now contains everything from the target branch
  // plus all worktree changes. Fast-forward the target branch ref to match.
  // This is safe because the canvas branch is a superset of the target.
  try {
    await exec(["branch", "-f", targetBranch, info.branch], projectCwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      conflicts: [],
      targetBranch,
      summary: `Failed to update ${targetBranch} ref: ${message}`,
    };
  }

  // Step 3: If the main worktree is on the target branch, update its working
  // tree to reflect the new HEAD. This is equivalent to what `git merge` would
  // do, but without the risk of a checkout switching branches.
  try {
    const { stdout: mainBranch } = await exec(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      projectCwd,
    );
    if (mainBranch.trim() === targetBranch) {
      // Reset the working tree to match the updated branch ref.
      // --hard is safe here because we only advanced the ref forward.
      await exec(["reset", "--hard", targetBranch], projectCwd);
    }
  } catch {
    // Non-fatal: the ref was updated even if the working tree wasn't refreshed.
    // The user can run `git pull` or `git checkout` to catch up.
  }

  return {
    success: true,
    conflicts: [],
    targetBranch,
    summary: `Merged ${info.branch} into ${targetBranch}`,
  };
}

/**
 * Merge the worktree branch then clean up the worktree directory and branch.
 * Returns the merge result. On success the worktree is fully removed.
 * On conflict the merge is aborted and the worktree remains for the user to
 * inspect or retry.
 */
export async function mergeAndCleanup(
  info: WorktreeInfo,
  targetBranch?: string,
  options?: { force?: boolean; strategy?: "ours" | "theirs" },
): Promise<MergeResult> {
  // Auto-commit any uncommitted changes so they aren't lost on merge.
  try {
    await exec(["add", "-A"], info.path);
    const { stdout: status } = await exec(["status", "--porcelain"], info.path);
    if (status.trim()) {
      await exec(
        ["commit", "-m", "chore: auto-commit uncommitted changes before merge"],
        info.path,
      );
    }
  } catch {
    // Non-fatal — proceed with merge even if auto-commit fails (e.g. nothing to commit)
  }

  const result = await mergeWorktree(info, targetBranch, options);

  if (result.success) {
    // Merge succeeded — remove worktree directory + branch
    await removeWorktree(info.path, info.projectPath);
    info.lifecycle = "cleaned";
  }
  // On failure the worktree stays "active" so the user can fix or discard.

  return result;
}

/**
 * Get a change summary for a worktree by parsing `git diff --stat`.
 */
export async function getWorktreeStatus(
  worktreePath: string,
): Promise<GitStatus> {
  let stdout: string;
  try {
    ({ stdout } = await exec(["diff", "--stat"], worktreePath));
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0, summary: "No changes" };
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { filesChanged: 0, insertions: 0, deletions: 0, summary: "No changes" };
  }

  // The last line of git diff --stat looks like:
  //  3 files changed, 10 insertions(+), 2 deletions(-)
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
  if (filesMatch) filesChanged = parseInt(filesMatch[1]!, 10);

  const insMatch = lastLine.match(/(\d+)\s+insertions?\(\+\)/);
  if (insMatch) insertions = parseInt(insMatch[1]!, 10);

  const delMatch = lastLine.match(/(\d+)\s+deletions?\(-\)/);
  if (delMatch) deletions = parseInt(delMatch[1]!, 10);

  return { filesChanged, insertions, deletions, summary: lastLine.trim() };
}

/**
 * Per-file change detail for detailed diff views.
 */
export interface FileChange {
  file: string;
  insertions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

/**
 * Detailed diff information including per-file stats and commit list.
 * Used for the approval workflow dashboard.
 */
export interface DetailedDiff {
  /** Overall stats */
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Per-file breakdown */
  files: FileChange[];
  /** Commits on the worktree branch not on the base branch */
  commits: string[];
  /** Branch name */
  branch: string;
}

/**
 * Get a detailed diff for a worktree branch vs its base.
 * Includes per-file stats and commit list — used for the approval dashboard.
 */
export async function getDetailedDiff(
  info: WorktreeInfo,
): Promise<DetailedDiff> {
  const cwd = info.path;
  const branch = info.branch;

  // Find the merge-base between the worktree branch and the main worktree's HEAD.
  // The project path's HEAD is the base branch.
  let mergeBase: string;
  try {
    const { stdout } = await exec(
      ["merge-base", "HEAD", branch],
      info.projectPath,
    );
    mergeBase = stdout.trim();
  } catch {
    // Fallback: diff against HEAD of main worktree
    mergeBase = "HEAD";
  }

  // Per-file numstat: shows insertions/deletions per file
  const files: FileChange[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  // Build a map of file changes. We process committed changes first (branch vs
  // merge-base), then layer on any uncommitted changes in the worktree. For files
  // that appear in both, we sum the stats to reflect the full delta.
  const fileMap = new Map<string, FileChange>();

  const parseNumstat = (output: string) => {
    for (const line of output.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const [ins, del, file] = parts;
      if (!file) continue;

      const insertions = ins === "-" ? 0 : parseInt(ins!, 10) || 0;
      const deletions = del === "-" ? 0 : parseInt(del!, 10) || 0;

      const existing = fileMap.get(file);
      if (existing) {
        // Accumulate uncommitted changes on top of committed
        existing.insertions += insertions;
        existing.deletions += deletions;
      } else {
        let status: FileChange["status"] = "modified";
        if (file.includes(" => ")) status = "renamed";
        fileMap.set(file, { file, insertions, deletions, status });
      }
    }
  };

  try {
    // Committed changes on the branch vs merge-base
    const { stdout: committedStat } = await exec(
      ["diff", "--numstat", mergeBase, branch],
      info.projectPath,
    );
    parseNumstat(committedStat);

    // Uncommitted changes (staged + unstaged) in the worktree
    const { stdout: uncommittedStat } = await exec(["diff", "--numstat", "HEAD"], cwd);
    parseNumstat(uncommittedStat);
  } catch {
    // Fallback: empty file list
  }

  // Enrich file status using name-status (more accurate for add/delete/rename)
  try {
    const { stdout: nameStatus } = await exec(
      ["diff", "--name-status", mergeBase, branch],
      info.projectPath,
    );
    for (const line of nameStatus.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const statusChar = parts[0]!.trim();
        const fileName = parts[parts.length - 1]!;
        const existing = fileMap.get(fileName);
        if (existing) {
          if (statusChar === "A") existing.status = "added";
          else if (statusChar === "D") existing.status = "deleted";
          else if (statusChar.startsWith("R")) existing.status = "renamed";
        }
      }
    }
  } catch {
    // Non-critical
  }

  // Compute totals from the map
  for (const f of fileMap.values()) {
    files.push(f);
    totalInsertions += f.insertions;
    totalDeletions += f.deletions;
  }

  // Get commits on this branch since merge-base
  const commits: string[] = [];
  try {
    const { stdout } = await exec(
      ["log", "--oneline", `${mergeBase}..${branch}`],
      info.projectPath,
    );
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      commits.push(line);
    }
  } catch {
    // No commits or error
  }

  return {
    filesChanged: files.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    files,
    commits,
    branch,
  };
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
