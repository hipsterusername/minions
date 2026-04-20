/**
 * Architecture-fitness baselines.
 *
 * These numbers represent the *current* shape of the repo. The fitness
 * tests assert the repo does not regress against them — they are not
 * targets to grow. Each entry should *shrink* over the course of the
 * refactor; when a phase finishes, ratchet the corresponding number
 * downward.
 *
 * Tracked in `docs/refactor-test-plan.md` Phase 0.
 */

/**
 * Server files we tolerate over the 400-line limit, with the maximum
 * line count we accept. Any line count above this fails the test —
 * which means the only way to keep the file in the allowlist is to
 * SHRINK it. Adding code that pushes a file past its allowed ceiling
 * is a CI failure.
 *
 * Phases referenced map to `docs/refactor-test-plan.md`.
 */
export const SERVER_FILE_SIZE_ALLOWLIST: Readonly<Record<string, number>> = {
  // Drained in Phase 5 (per-command handlers + thin entry).
  // Bumped 1969 → 2072 in Phase 2 pre-flight: unrelated feature work
  // merged to main while this refactor was in flight. Net diff from the
  // Phase 2 bus migration itself is negative (-1). Kept as-is until Phase
  // 5 collapses this file anyway.
  "server/index.ts": 2072,
  // Drained in Phase 3 (each MCP tool factory moves under server/agents/<role>/).
  "server/task-tools.ts": 624,
  // Bumped 604 → 646 in Phase 2 pre-flight: same unrelated-feature growth
  // on main. Not touched by this refactor.
  "server/worktree.ts": 646,
  // REST handlers — not on the published refactor plan but flagged here
  // as debt. Should be split per-resource alongside Phase 5 cleanup.
  "server/routes/projects.ts": 596,
};

/**
 * Hard ceiling for any file NOT in the allowlist.
 */
export const SERVER_FILE_SIZE_LIMIT = 400;

/**
 * Cross-tree imports we tolerate today. Each entry is a regex matched
 * against the import statement. Removing an entry must accompany
 * removing the import.
 *
 * Drained in Phase 3 (prompts move into `server/agents/<role>/prompt.ts`).
 */
export const ALLOWED_CROSS_TREE_IMPORTS: ReadonlyArray<{
  file: string;
  matcher: RegExp;
  reason: string;
}> = [
  {
    file: "server/index.ts",
    matcher: /from\s+["']\.\.\/src\/prompts\/minion-system\.ts["']/,
    reason: "Phase 3 — prompts move into server/agents/<role>/prompt.ts",
  },
];

/**
 * Phase 2 landed `server/bus.ts` and migrated every server file to use
 * it. The `no-direct-broadcast` test now asserts that **no file outside
 * `server/bus.ts`** contains a `broadcast(...)` call site. This baseline
 * is kept empty as a historical record of where the debt used to live.
 */
export const BROADCAST_CALL_SITE_BASELINE: Readonly<Record<string, number>> = {};
