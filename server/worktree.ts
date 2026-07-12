// ── Barrel re-export ───────────────────────────────────────────────────────
// All public symbols from the worktree subsystem are re-exported here so
// existing callers don't need import-path updates.

export type {
  WorktreeLifecycle,
  WorktreeInfo,
  MergeResult,
  GitStatus,
  FileChange,
  DetailedDiff,
} from "./worktree-types.js";

export {
  createWorktree,
  provisionPlannedWorktree,
  resolveWorktreeBase,
  removeWorktree,
  listWorktrees,
  isGitRepo,
  cleanupStaleWorktrees,
} from "./worktree-create.js";

export {
  mergeWorktree,
  mergeAndCleanup,
} from "./worktree-merge.js";

export {
  getWorktreeStatus,
  getDetailedDiff,
} from "./worktree-diff.js";
