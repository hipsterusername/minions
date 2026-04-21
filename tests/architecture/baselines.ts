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
  // Drained in Phase 3 (each MCP tool factory moves under server/agents/<role>/).
  "server/task-tools.ts": 624,
// Phase 5.3 split server/routes/projects.ts into per-resource modules
  // under server/routes/projects/ — barrel is now under 400 lines.
  // Phase 5.1 + 5.2 retired server/index.ts from the allowlist — it
  // dropped from 2072 → 243 after extracting SessionHost and splitting
  // the command dispatcher into per-file handlers under server/commands/.
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
 * Phase 3 drained the last entry: the minion system prompt moved from
 * `src/prompts/minion-system.ts` into `server/agents/minion.ts`.
 */
export const ALLOWED_CROSS_TREE_IMPORTS: ReadonlyArray<{
  file: string;
  matcher: RegExp;
  reason: string;
}> = [];

/**
 * Phase 2 landed `server/bus.ts` and migrated every server file to use
 * it. The `no-direct-broadcast` test now asserts that **no file outside
 * `server/bus.ts`** contains a `broadcast(...)` call site. This baseline
 * is kept empty as a historical record of where the debt used to live.
 */
export const BROADCAST_CALL_SITE_BASELINE: Readonly<Record<string, number>> = {};
