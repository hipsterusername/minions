/**
 * Architecture fitness — direct broadcast call site count does not grow.
 *
 * Phase 2 of the refactor introduces `server/bus.ts` with a typed
 * envelope and topic subscription. Until then we accept the existing
 * direct `broadcast(...)` call sites — but no new ones may be added.
 *
 * After Phase 2 lands `server/bus.ts`, this test should be flipped:
 *   - the per-file baseline becomes 0 for everything except bus.ts
 *   - any non-zero count outside bus.ts is a failure
 *
 * See `docs/testing-strategy.md` §3 (L4) and `tests/architecture/baselines.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BROADCAST_CALL_SITE_BASELINE } from "./baselines.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");

/** Match any `broadcast(` call (including the helper-fn definition itself). */
const BROADCAST_RE = /\bbroadcast\s*\(/g;

function listServerFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  walk(SERVER_DIR);
  return out;
}

function countMatches(absPath: string, re: RegExp): number {
  const text = readFileSync(absPath, "utf8");
  return (text.match(re) ?? []).length;
}

describe("architecture: direct broadcast call sites do not grow", () => {
  const files = listServerFiles().map((f) => ({
    path: f,
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    count: countMatches(f, BROADCAST_RE),
  }));

  for (const f of files) {
    const baseline = BROADCAST_CALL_SITE_BASELINE[f.rel] ?? 0;

    it(`${f.rel} has ≤ ${baseline} broadcast call site(s)`, () => {
      expect(
        f.count,
        baseline === 0
          ? `${f.rel} added a new direct broadcast call (count: ${f.count}). ` +
              `New broadcasts must go through server/bus.ts (Phase 2 of the ` +
              `refactor) or, if bus.ts doesn't exist yet, the file must be ` +
              `added to BROADCAST_CALL_SITE_BASELINE in tests/architecture/baselines.ts.`
          : `${f.rel} grew from ${baseline} to ${f.count} broadcast call sites. ` +
              `New broadcasts must go through server/bus.ts. To intentionally ` +
              `shrink the count, ratchet the entry in BROADCAST_CALL_SITE_BASELINE ` +
              `down to match.`,
      ).toBeLessThanOrEqual(baseline);
    });
  }

  it("baseline entries refer to files that still exist", () => {
    const realFiles = new Set(files.map((f) => f.rel));
    for (const rel of Object.keys(BROADCAST_CALL_SITE_BASELINE)) {
      expect(
        realFiles.has(rel),
        `Baseline references ${rel} but no such file exists. ` +
          `Remove the entry from BROADCAST_CALL_SITE_BASELINE.`,
      ).toBe(true);
    }
  });
});
