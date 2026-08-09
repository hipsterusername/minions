/**
 * Architecture-fitness baselines.
 *
 * These numbers represent the *current* shape of the repo. The fitness
 * tests assert the repo does not regress against them — they are not
 * targets to grow. Ratchet each entry downward as the corresponding file
 * shrinks.
 */

/**
 * Server files we tolerate over the 400-line limit, with the maximum
 * line count we accept. Any line count above this fails the test —
 * which means the only way to keep the file in the allowlist is to
 * SHRINK it. Adding code that pushes a file past its allowed ceiling
 * is a CI failure.
 *
 */
export const SERVER_FILE_SIZE_ALLOWLIST: Readonly<Record<string, number>> = {};

/**
 * Hard ceiling for any file NOT in the allowlist.
 */
export const SERVER_FILE_SIZE_LIMIT = 400;

/**
 * Cross-tree imports we tolerate today. Each entry is a regex matched
 * against the import statement. Removing an entry must accompany
 * removing the import.
 */
export const ALLOWED_CROSS_TREE_IMPORTS: ReadonlyArray<{
  file: string;
  matcher: RegExp;
  reason: string;
}> = [];

/** Direct broadcast call sites allowed outside `server/bus.ts`. */
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
 */
export const CLIENT_FILE_SIZE_ALLOWLIST: Readonly<Record<string, number>> = {
  "src/Canvas.tsx": 4470,
  "src/nodes/LeaderNode.tsx": 1671,
  "src/nodes/ClaudeSessionNode.tsx": 1521,
};
