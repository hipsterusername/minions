
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
