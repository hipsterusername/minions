import type { WorktreeInfo, GitStatus, FileChange, DetailedDiff } from "./worktree-types.js";
import { exec } from "./worktree-exec.js";

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
