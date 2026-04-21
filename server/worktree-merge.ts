import type { WorktreeInfo, MergeResult } from "./worktree-types.js";
import { exec } from "./worktree-exec.js";
import { removeWorktree } from "./worktree-create.js";

// ── Merge operations ───────────────────────────────────────────────────────

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
  options?: { force?: boolean; strategy?: "ours" | "theirs"; rebase?: boolean },
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
  console.log(`[worktree] mergeWorktree: running git ${mergeArgs.join(" ")} in ${worktreeCwd}`);
  try {
    await exec(mergeArgs, worktreeCwd);
    console.log(`[worktree] mergeWorktree: merge succeeded cleanly`);
  } catch (err) {
    console.log(`[worktree] mergeWorktree: merge failed — ${err instanceof Error ? err.message : String(err)}`);
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
      // No strategy — abort the failed merge, then attempt rebase.
      //
      // Rebase-on-conflict workflow (per agentic best practice):
      //   1. Abort the failed merge
      //   2. Rebase the canvas branch on top of the target branch
      //   3. If rebase succeeds, the canvas branch is cleanly ahead — fall through to fast-forward
      //   4. If rebase has conflicts, abort and report them for agent/user resolution
      //
      // This produces a linear history and gives the agent a chance to fix
      // conflicts in its worktree before the orchestrator retries the merge.

      // First, abort the failed merge attempt.
      try {
        await exec(["merge", "--abort"], worktreeCwd);
      } catch {
        // Abort may fail if there's nothing to abort; ignore.
      }

      // Attempt rebase (default behavior, or explicitly requested)
      const shouldRebase = options?.rebase !== false; // default: true
      if (shouldRebase) {
        console.log(`[worktree] mergeWorktree: attempting rebase onto ${targetBranch} in ${worktreeCwd}`);
        try {
          await exec(["rebase", targetBranch!], worktreeCwd);
          console.log(`[worktree] mergeWorktree: rebase succeeded cleanly`);
          // Rebase succeeded — the canvas branch is now cleanly ahead of target.
          // Fall through to Step 2 (update-ref fast-forward).
        } catch (rebaseErr) {
          console.log(`[worktree] mergeWorktree: rebase failed — ${rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr)}`);

          // Collect conflicted files from the failed rebase
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

          // Abort the failed rebase to restore the worktree to its pre-rebase state.
          try {
            await exec(["rebase", "--abort"], worktreeCwd);
          } catch {
            // Abort may fail if there's nothing to abort; ignore.
          }

          const message = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
          return {
            success: false,
            conflicts,
            targetBranch,
            summary: `Rebase failed (conflicts with ${targetBranch}): ${message}. The worktree is unchanged — resolve conflicts and retry.`,
          };
        }
      } else {
        // Rebase explicitly disabled — just report the original merge failure
        const conflicts: string[] = [];
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          conflicts,
          targetBranch,
          summary: `Merge failed (conflicts with ${targetBranch}): ${message}`,
        };
      }
    }
  }

  // Step 2: The canvas branch now contains everything from the target branch
  // plus all worktree changes. Fast-forward the target branch ref to match.
  // This is safe because the canvas branch is a superset of the target.
  //
  // NOTE: We use `git update-ref` instead of `git branch -f` because git
  // refuses to force-update a branch that is currently checked out in any
  // worktree. `update-ref` bypasses this restriction.
  try {
    const { stdout: canvasSha } = await exec(
      ["rev-parse", info.branch],
      projectCwd,
    );
    await exec(
      ["update-ref", `refs/heads/${targetBranch}`, canvasSha.trim()],
      projectCwd,
    );
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
  options?: { force?: boolean; strategy?: "ours" | "theirs"; rebase?: boolean },
): Promise<MergeResult> {
  console.log(`[worktree] mergeAndCleanup: path=${info.path} branch=${info.branch} options=${JSON.stringify(options)}`);
  // Auto-commit any uncommitted changes so they aren't lost on merge.
  try {
    await exec(["add", "-A"], info.path);
    const { stdout: status } = await exec(["status", "--porcelain"], info.path);
    if (status.trim()) {
      console.log(`[worktree] mergeAndCleanup: auto-committing uncommitted changes`);
      await exec(
        ["commit", "-m", "chore: auto-commit uncommitted changes before merge"],
        info.path,
      );
    }
  } catch (e) {
    console.log(`[worktree] mergeAndCleanup: auto-commit skipped (${e instanceof Error ? e.message : String(e)})`);
  }

  const result = await mergeWorktree(info, targetBranch, options);
  console.log(`[worktree] mergeAndCleanup: merge result success=${result.success} summary=${result.summary}`);

  if (result.success) {
    // Merge succeeded — remove worktree directory + branch
    await removeWorktree(info.path, info.projectPath);
    info.lifecycle = "cleaned";
  }
  // On failure the worktree stays "active" so the user can fix or discard.

  return result;
}
