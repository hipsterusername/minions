import type { WorktreeInfo, MergeResult } from "./worktree-types.js";
import { exec } from "./worktree-exec.js";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("worktree-merge");

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
  options?: { force?: boolean; strategy?: "ours" | "theirs"; rebase?: boolean; validateResult?: () => Promise<boolean> },
): Promise<MergeResult> {
  const projectCwd = info.projectPath;
  const worktreeCwd = info.path;

  // If no target specified, determine the current branch of the main worktree.
  if (!targetBranch) {
    const { stdout } = await exec(["rev-parse", "--abbrev-ref", "HEAD"], projectCwd);
    targetBranch = stdout.trim();
  }

  let targetShaBefore = "";
  let targetCheckedOutInMain = false;
  try {
    const [{ stdout: targetSha }, { stdout: mainBranch }] = await Promise.all([
      exec(["rev-parse", `refs/heads/${targetBranch}`], projectCwd),
      exec(["rev-parse", "--abbrev-ref", "HEAD"], projectCwd),
    ]);
    targetShaBefore = targetSha.trim();
    targetCheckedOutInMain = mainBranch.trim() === targetBranch;

    if (targetCheckedOutInMain) {
      const { stdout: status } = await exec(["status", "--porcelain"], projectCwd);
      if (status.trim()) {
        return {
          success: false,
          conflicts: [],
          targetBranch,
          summary: `Cannot merge ${info.branch}: ${targetBranch} is checked out with uncommitted changes. Commit, stash, or discard them first.`,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      conflicts: [],
      targetBranch,
      summary: `Failed to inspect ${targetBranch} before merge: ${message}`,
    };
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
  log.debug("merge_started", {
    targetBranch,
    strategy: strategy ?? "default",
    worktreePath: worktreeCwd,
  });
  try {
    await exec(mergeArgs, worktreeCwd);
    log.debug("merge_succeeded", { targetBranch });
  } catch (err) {
    log.debug("merge_attempt_failed", { targetBranch, error: err });
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
        log.debug("rebase_started", {
          targetBranch,
          worktreePath: worktreeCwd,
        });
        try {
          await exec(["rebase", targetBranch!], worktreeCwd);
          log.debug("rebase_succeeded", { targetBranch });
          // Rebase succeeded — the canvas branch is now cleanly ahead of target.
          // Fall through to Step 2 (update-ref fast-forward).
        } catch (rebaseErr) {
          log.debug("rebase_failed", { targetBranch, error: rebaseErr });

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
  // Checked-out targets use Git's fast-forward merge to preserve concurrent edits.
  // Unchecked targets use a compare-and-swap ref update against the observed SHA.
  try {
    if (options?.validateResult && !await options.validateResult()) return { success: false,
      conflicts: [], targetBranch, summary: "The combined worktree needs current passing verification before updating the target. Review it and retry." };
    if (targetCheckedOutInMain) {
      const { stdout: status } = await exec(["status", "--porcelain"], projectCwd);
      if (status.trim()) {
        return {
          success: false,
          conflicts: [],
          targetBranch,
          summary: `Cannot finalize merge: ${targetBranch} became dirty while merging. The worktree branch is intact; clean the target checkout and retry.`,
        };
      }
    }
    const { stdout: canvasSha } = await exec(
      ["rev-parse", info.branch],
      projectCwd,
    );
    const checkouts = (await exec(["worktree", "list", "--porcelain"], projectCwd)).stdout.split("\n\n");
    const checkedOut = checkouts.find(block => block.split("\n").includes(`branch refs/heads/${targetBranch}`));
    const checkout = checkedOut?.split("\n").find(line => line.startsWith("worktree "))?.slice(9);
    if (checkout) {
      if ((await exec(["status", "--porcelain"], checkout)).stdout.trim()) throw new Error("target checkout is dirty");
      await exec(["merge", "--ff-only", canvasSha.trim()], checkout);
    } else {
      await exec(["update-ref", `refs/heads/${targetBranch}`, canvasSha.trim(), targetShaBefore], projectCwd);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      conflicts: [],
      targetBranch,
      summary: `Failed to update ${targetBranch} ref safely: ${message}`,
    };
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
  options?: { force?: boolean; strategy?: "ours" | "theirs"; rebase?: boolean; validateResult?: () => Promise<boolean> },
): Promise<MergeResult> {
  log.debug("merge_and_cleanup_started", {
    branch: info.branch,
    targetBranch,
    worktreePath: info.path,
    options,
  });
  // Auto-commit any uncommitted changes so they aren't lost on merge.
  try {
    await exec(["add", "-A"], info.path);
    const { stdout: status } = await exec(["status", "--porcelain"], info.path);
    if (status.trim()) {
      log.debug("auto_commit_started", { branch: info.branch });
      await exec(
        ["commit", "-m", "chore: auto-commit uncommitted changes before merge"],
        info.path,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("auto_commit_failed", { branch: info.branch, error: e });
    return {
      success: false,
      conflicts: [],
      targetBranch,
      summary: `Failed to prepare ${info.branch} for merge: ${message}`,
    };
  }

  const result = await mergeWorktree(info, targetBranch, options);
  log.debug("merge_and_cleanup_completed", {
    success: result.success,
    targetBranch: result.targetBranch,
    conflictCount: result.conflicts.length,
  });

  if (result.success) {
    // Merge succeeded — remove worktree directory + branch
    try {
      const ref = info.branch.startsWith("refs/") ? info.branch : `refs/heads/${info.branch}`;
      const head = (await exec(["rev-parse", ref], info.projectPath)).stdout.trim();
      await exec(["merge-base", "--is-ancestor", head, `refs/heads/${result.targetBranch}`], info.projectPath);
      // Git itself refuses to remove a checkout with edits made since collection.
      await exec(["worktree", "remove", info.path], info.projectPath);
      await exec(["update-ref", "-d", ref, head], info.projectPath);
      info.lifecycle = "cleaned";
    } catch (error) {
      return { ...result, success: false, summary: `${result.summary}; cleanup deferred: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  // On failure the worktree stays "active" so the user can fix or discard.

  return result;
}
