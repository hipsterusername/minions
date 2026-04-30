/**
 * Architecture fitness — file-size baseline is one-way (downward).
 *
 * Per `docs/testing-strategy.md` §6.1, every entry in
 * `tests/architecture/baselines.ts::SERVER_FILE_SIZE_ALLOWLIST` may only
 * RATCHET DOWN over time. The mechanism existed before this test landed
 * but was treated as a value the team could move either way — git history
 * shows `server/index.ts` was bumped 1966 → 1969 → 2072 to absorb growth
 * the test was supposed to gate. This lint stops that.
 *
 * How it works:
 *   1. Read the current `SERVER_FILE_SIZE_ALLOWLIST`.
 *   2. Read the same record from the previous commit via `git show HEAD~1`.
 *   3. For every key present in BOTH, assert current ≤ previous.
 *   4. New keys are tolerated (they default to 0 → current); existing
 *      keys removed from the allowlist are tolerated (the file either
 *      shrank under the limit or was deleted, both of which are fine).
 *
 * Override mechanism:
 *   If a baseline genuinely must grow — e.g. an unrelated refactor merged
 *   to main while an in-flight refactor was reorganising the same file —
 *   add the comment `// RATCHET_UP_OK: <reason>` on the line being
 *   raised in `baselines.ts`. The waiver applies for the commit it lands
 *   in; the next commit must not preserve the waiver if the file did not
 *   actually need to grow further.
 *
 * The baseline file's git blob at HEAD~1 is read, not the comparison
 * commit's working tree, because the test runs against the current
 * checkout in CI. Resolving against a remote branch would couple the
 * test to a particular branch layout.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { SERVER_FILE_SIZE_ALLOWLIST } from "./baselines.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BASELINE_PATH = "tests/architecture/baselines.ts";

interface ParsedAllowlist {
  values: Record<string, number>;
  /** Keys whose line in the source carries a RATCHET_UP_OK waiver. */
  waivers: ReadonlySet<string>;
}

/**
 * Parse `SERVER_FILE_SIZE_ALLOWLIST` from a `baselines.ts` source string.
 * The shape is `"<path>": <number>,` per line — a regex is sufficient
 * and avoids loading the file as a TS module.
 */
function parseAllowlist(source: string): ParsedAllowlist {
  const values: Record<string, number> = {};
  const waivers = new Set<string>();
  const lineRe = /^\s*"([^"]+)"\s*:\s*(\d+)\s*,/;
  const waiverRe = /\/\/\s*RATCHET_UP_OK:\s*\S/;
  for (const line of source.split("\n")) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const value = Number(match[2]);
    values[key] = value;
    if (waiverRe.test(line)) waivers.add(key);
  }
  return { values, waivers };
}

function readPreviousBaseline(): ParsedAllowlist | null {
  try {
    const out = execSync(`git show HEAD~1:${BASELINE_PATH}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseAllowlist(out);
  } catch {
    // No previous commit (first commit on a fresh repo / shallow clone
    // without HEAD~1). Treat as "nothing to compare against".
    return null;
  }
}

describe("architecture: file-size baseline ratchets only downward", () => {
  const previous = readPreviousBaseline();

  it("can read the previous commit's baselines (or skips on shallow checkout)", () => {
    // Soft assertion: if HEAD~1 doesn't exist (first commit / shallow CI
    // checkout), we have nothing to compare. The test still passes —
    // the rule activates as soon as a second commit lands.
    expect(previous === null || typeof previous.values === "object").toBe(true);
  });

  if (previous === null) return;

  for (const [key, prevValue] of Object.entries(previous.values)) {
    const current = SERVER_FILE_SIZE_ALLOWLIST[key];
    if (current === undefined) {
      // Key removed from the allowlist this commit — fine. Either the
      // file shrank past the global limit (good) or was deleted entirely.
      continue;
    }
    if (current <= prevValue) continue;

    // The current commit raises the ceiling. Allowed only with an
    // explicit waiver on the line being raised.
    it(`baseline for ${key} (${prevValue} → ${current}) requires a RATCHET_UP_OK waiver`, () => {
      // Re-read the CURRENT allowlist source to check for the waiver.
      // We can't read it from the imported value because comments are
      // stripped at module load.
      const head = execSync(`git show HEAD:${BASELINE_PATH}`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = parseAllowlist(head);
      const hasWaiver = parsed.waivers.has(key);
      expect(
        hasWaiver,
        [
          `${key} grew from ${prevValue} to ${current} in the allowlist.`,
          `Per docs/testing-strategy.md §6.1, baselines may only ratchet DOWN.`,
          `If this growth is intentional, add the waiver:`,
          ``,
          `  "${key}": ${current}, // RATCHET_UP_OK: <reason>`,
          ``,
          `Otherwise, shrink the file or split it instead of raising the ceiling.`,
        ].join("\n"),
      ).toBe(true);
    });
  }
});
