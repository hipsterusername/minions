import { execFile as execFileCb } from "node:child_process";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join, basename } from "node:path";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  leaderSessionKey: string;
  createdAt: number;
  projectPath: string;
}

export interface MergeResult {
  success: boolean;
  conflicts: string[];
  summary: string;
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
  };
}

/**
 * Force-remove a worktree and delete its branch.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  // Derive the branch name from the worktree directory name.
  const key = basename(worktreePath);
  const branch = `canvas/${key}`;

  // Derive the project path (two levels up from .canvas-worktrees/<key>).
  const projectPath = join(worktreePath, "..", "..");

  await exec(["worktree", "remove", "--force", worktreePath], projectPath);
  await exec(["branch", "-D", branch], projectPath);
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
      });
    }
  }

  return results;
}

/**
 * Merge the worktree branch into a target branch (default: current branch
 * of the main worktree). Aborts on conflict and returns conflict details.
 */
export async function mergeWorktree(
  info: WorktreeInfo,
  targetBranch?: string,
): Promise<MergeResult> {
  const cwd = info.projectPath;

  // If no target specified, determine the current branch of the main worktree.
  if (!targetBranch) {
    const { stdout } = await exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    targetBranch = stdout.trim();
  }

  // Ensure we're on the target branch.
  await exec(["checkout", targetBranch], cwd);

  try {
    const { stdout } = await exec(
      ["merge", "--no-ff", info.branch],
      cwd,
    );
    return {
      success: true,
      conflicts: [],
      summary: stdout.trim(),
    };
  } catch (err) {
    // Check for merge conflicts by looking at unmerged paths.
    let conflicts: string[] = [];
    try {
      const { stdout: diffOut } = await exec(
        ["diff", "--name-only", "--diff-filter=U"],
        cwd,
      );
      conflicts = diffOut.trim().split("\n").filter(Boolean);
    } catch {
      // If diff fails too, just use the error message.
    }

    // Abort the failed merge.
    try {
      await exec(["merge", "--abort"], cwd);
    } catch {
      // Abort may fail if there's nothing to abort; ignore.
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      conflicts,
      summary: `Merge failed: ${message}`,
    };
  }
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
