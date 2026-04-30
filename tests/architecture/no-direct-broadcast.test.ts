/**
 * Architecture fitness — no direct `broadcast(...)` calls outside the bus.
 *
 * Phase 2 of the refactor landed `server/bus.ts`. All server → client
 * traffic must flow through the bus. The only file allowed to contain
 * `broadcast(...)` call sites is `server/bus.ts` itself.
 *
 * See `docs/testing-strategy.md` §3 (L4) and `tests/architecture/baselines.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");

/** The only file allowed to contain `broadcast(...)` call sites. */
const BUS_FILE = "server/bus.ts";

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

describe("architecture: no direct broadcast outside server/bus.ts", () => {
  const files = listServerFiles().map((f) => ({
    path: f,
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    count: countMatches(f, BROADCAST_RE),
  }));

  for (const f of files.filter((x) => x.rel !== BUS_FILE)) {
    it(`${f.rel} has no broadcast call sites`, () => {
      expect(
        f.count,
        `${f.rel} has ${f.count} direct broadcast call site(s). ` +
          `All broadcasts must go through server/bus.ts.`,
      ).toBe(0);
    });
  }

  // Note: a "bus.ts has at least one broadcast call" sanity is dropped per
  // testing-strategy.md §5.7 (TRIVIAL) — bus.ts not having broadcast() would
  // fail the build long before this test could run.
});
