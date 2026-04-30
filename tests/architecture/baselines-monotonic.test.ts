/**
 * Architecture fitness — baselines may only ratchet downward.
 *
 * Per `docs/testing-strategy.md` §6.1: the baselines in
 * `tests/architecture/baselines.ts` express the *current* shape of the
 * repo's debt. They are not goals to grow into. Any PR that pushes a
 * value upward is a CI failure unless the diff carries a
 * `RATCHET_UP_OK: <reason>` annotation explaining why the regression
 * is intentional.
 *
 * Implementation: read `baselines.ts` at HEAD~1 and HEAD via `git show`.
 * For every key shared between the two versions, assert
 * `HEAD <= HEAD~1`. New keys are allowed (a baseline can be added).
 * Removed keys are allowed (the debt was retired entirely).
 *
 * If git history isn't available (shallow clone, fresh repo), the test
 * is a no-op rather than a failure — CI environments may not always
 * have HEAD~1. The local pre-commit hook is the primary gate.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BASELINES_PATH = "tests/architecture/baselines.ts";

/**
 * Numeric maps inside baselines.ts that the monotonic check applies to.
 * Each entry names the exported `Record<string, number>` constant; the
 * extractor walks the source for `<NAME>: Readonly<Record<string, number>> = { ... }`
 * and parses the inner key/value pairs.
 */
const TRACKED_MAPS: ReadonlyArray<string> = [
  "SERVER_FILE_SIZE_ALLOWLIST",
  "BROADCAST_CALL_SITE_BASELINE",
];

/**
 * Read `baselines.ts` at a git revision. Returns null if the revision
 * is unreachable (e.g. shallow clone) or the file did not exist there.
 */
function readBaselinesAtRev(rev: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${BASELINES_PATH}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Extract a numeric map's entries from baselines.ts source. Tolerant of
 * whitespace, comments, and trailing commas. Returns an empty map if
 * the constant exists but has no entries.
 */
function parseNumericMap(source: string, name: string): Map<string, number> {
  const declRe = new RegExp(
    `export\\s+const\\s+${name}\\s*:[^=]*=\\s*\\{([\\s\\S]*?)\\}\\s*;`,
    "m",
  );
  const match = source.match(declRe);
  const out = new Map<string, number>();
  if (!match || !match[1]) return out;

  const body = match[1];
  // Match `"key": 123` or `'key': 123` entries. Comments are ignored
  // because the regex only fires on the key/number shape.
  const entryRe = /["']([^"']+)["']\s*:\s*(\d+)/g;
  for (const m of body.matchAll(entryRe)) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) {
      out.set(key, Number.parseInt(value, 10));
    }
  }
  return out;
}

/**
 * The escape-hatch annotation: a comment of the form
 * `RATCHET_UP_OK: <reason>` anywhere in the new baselines.ts allows
 * any upward bump in the same commit. The annotation must include a
 * non-empty reason — the matcher rejects the bare marker.
 */
function hasRatchetOverride(headSource: string): boolean {
  return /RATCHET_UP_OK:\s*\S/.test(headSource);
}

describe("architecture: baselines may only ratchet downward (§6.1)", () => {
  const headSource = readBaselinesAtRev("HEAD");
  const prevSource = readBaselinesAtRev("HEAD~1");

  // Skip the test gracefully on shallow clones / fresh repos where
  // HEAD~1 isn't reachable. The intent is a CI gate; a missing parent
  // just means there's nothing to compare against yet.
  if (headSource === null || prevSource === null) {
    it.skip("skipped: HEAD or HEAD~1 baselines.ts is unreachable", () => {});
    return;
  }

  const overrideActive = hasRatchetOverride(headSource);

  for (const mapName of TRACKED_MAPS) {
    it(`${mapName}: every shared key has HEAD value ≤ HEAD~1 value`, () => {
      const head = parseNumericMap(headSource, mapName);
      const prev = parseNumericMap(prevSource, mapName);

      const offenders: string[] = [];
      for (const [key, prevValue] of prev) {
        const headValue = head.get(key);
        if (headValue === undefined) continue; // entry retired — fine
        if (headValue > prevValue) {
          offenders.push(
            `  ${key}: ${prevValue} → ${headValue} (+${headValue - prevValue})`,
          );
        }
      }

      if (offenders.length === 0) return;

      if (overrideActive) {
        // The committer flagged the bump as intentional. Don't fail —
        // but record it on stderr so it's visible in CI logs.
        // eslint-disable-next-line no-console
        console.warn(
          `[baselines-monotonic] RATCHET_UP_OK override active in HEAD baselines.ts; allowing:\n${offenders.join("\n")}`,
        );
        return;
      }

      expect(
        offenders,
        `Baseline ${mapName} ratcheted UPWARD without a \`RATCHET_UP_OK: <reason>\` annotation in baselines.ts:\n${offenders.join("\n")}\n\nBaselines are debt counters; they exist to shrink. If a regression is genuinely intentional (a phased migration, a tolerated new debt entry), add a comment like \`// RATCHET_UP_OK: <reason>\` in baselines.ts as part of the same commit.`,
      ).toEqual([]);
    });
  }
});
