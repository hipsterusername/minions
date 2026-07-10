/**
 * Architecture-fitness baselines.
 *
 * These numbers represent the *current* shape of the repo. The fitness
 * tests assert the repo does not regress against them — they are not
 * targets to grow. Each entry should *shrink* over the course of the
 * refactor; when a phase finishes, ratchet the corresponding number
 * downward.
 *
 * Refactor outcomes are summarized in `docs/archive/phase-5-complete.md`.
 */

/**
 * Server files we tolerate over the 400-line limit, with the maximum
 * line count we accept. Any line count above this fails the test —
 * which means the only way to keep the file in the allowlist is to
 * SHRINK it. Adding code that pushes a file past its allowed ceiling
 * is a CI failure.
 *
 */
export const SERVER_FILE_SIZE_ALLOWLIST: Readonly<Record<string, number>> = {
  // Phase 5.3 split server/task-tools.ts into per-tool modules
  // under server/task-tools/ — barrel is now under 400 lines.
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

/**
 * Client (src/) files tracked as "shrink-only" ceilings.
 *
 * CLAUDE.md calls out Canvas.tsx, LeaderNode.tsx, and ClaudeSessionNode.tsx
 * as known-oversized files. Every PR must hold steady or shrink them —
 * growth fails CI. Baselines are set to the line counts at the time this
 * gate was introduced; ratchet them down as the files shrink.
 *
 * Line counting uses the same newline-count (`wc -l`) semantics as the
 * server file-size test: count `\n` characters, not visual rows.
 *
 * Note: another minion may be actively shrinking ClaudeSessionNode.tsx —
 * the baseline here is the current count at gate-introduction time; any
 * shrink still passes (only growth fails).
 */
export const CLIENT_FILE_SIZE_ALLOWLIST: Readonly<Record<string, number>> = {
  "src/Canvas.tsx": 4470,
  "src/nodes/LeaderNode.tsx": 1671,
  "src/nodes/ClaudeSessionNode.tsx": 1521,
};
