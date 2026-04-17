/**
 * Architecture fitness — server file size.
 *
 * Enforces:
 *   1. Any file in `server/*.ts` that is NOT in the allowlist must be
 *      ≤ SERVER_FILE_SIZE_LIMIT lines. Adding an oversized file is a
 *      CI failure.
 *   2. Any file IN the allowlist must not grow past its recorded
 *      ceiling. Adding code that pushes an allowlisted file higher is
 *      a CI failure — the only way to update the allowlist is to
 *      shrink the file.
 *
 * See `docs/testing-strategy.md` §3 (L4) and `tests/architecture/baselines.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  SERVER_FILE_SIZE_ALLOWLIST,
  SERVER_FILE_SIZE_LIMIT,
} from "./baselines.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");

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

function lineCount(absPath: string): number {
  // Match `wc -l` semantics: count newline characters. A file ending in
  // a newline has N newlines and N "lines" by this count.
  const text = readFileSync(absPath, "utf8");
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) n += 1;
  }
  return n;
}

describe("architecture: server file size", () => {
  const files = listServerFiles().map((f) => ({
    path: f,
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    lines: lineCount(f),
  }));

  it("is reading at least a few server files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const allowed = SERVER_FILE_SIZE_ALLOWLIST[f.rel];

    if (allowed === undefined) {
      it(`${f.rel} is at most ${SERVER_FILE_SIZE_LIMIT} lines`, () => {
        expect(
          f.lines,
          `${f.rel} is ${f.lines} lines, over the ${SERVER_FILE_SIZE_LIMIT}-line ` +
            `limit. Either split the file or — if there is a documented refactor ` +
            `phase that will drain it — add it to SERVER_FILE_SIZE_ALLOWLIST in ` +
            `tests/architecture/baselines.ts with the current line count as the ceiling.`,
        ).toBeLessThanOrEqual(SERVER_FILE_SIZE_LIMIT);
      });
    } else {
      it(`${f.rel} is on the oversize allowlist and has not grown past ${allowed} lines`, () => {
        expect(
          f.lines,
          `${f.rel} grew from the allowlist ceiling of ${allowed} to ${f.lines}. ` +
            `Allowlist entries may only SHRINK. If you intentionally reduced ` +
            `the file, ratchet the value in baselines.ts down to match.`,
        ).toBeLessThanOrEqual(allowed);
      });
    }
  }

  it("allowlist entries refer to files that still exist", () => {
    const realFiles = new Set(
      files.map((f) => f.rel),
    );
    for (const rel of Object.keys(SERVER_FILE_SIZE_ALLOWLIST)) {
      expect(
        realFiles.has(rel),
        `Allowlist references ${rel} but no such file exists. ` +
          `Remove the entry from SERVER_FILE_SIZE_ALLOWLIST.`,
      ).toBe(true);
    }
  });
});
