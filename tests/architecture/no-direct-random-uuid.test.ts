/**
 * Architecture fitness — no direct `crypto.randomUUID()` calls in `src/`.
 *
 * `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost).
 * The canvas is routinely opened over plain HTTP on a LAN address, where the
 * call throws a `TypeError` — which has repeatedly turned click handlers into
 * silent no-ops (mobile leader launch, then the Activity tab's Mark reviewed /
 * Dismiss / bulk-dismiss workflows). All browser code must mint IDs through
 * `src/random-id.ts` `randomUuid()`, which falls back to `getRandomValues`.
 *
 * Server code (`server/`) may use `crypto.randomUUID()` freely — Node always
 * provides it — so this test only walks `src/`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

/** The only browser-side file allowed to touch `crypto.randomUUID`. */
const RANDOM_ID_FILE = "src/random-id.ts";

const RANDOM_UUID_RE = /\bcrypto\s*\.\s*randomUUID\s*\(/;

function listSrcFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.includes(".test.")
      ) {
        out.push(full);
      }
    }
  }
  walk(SRC_DIR);
  return out;
}

/** Count call sites on code lines, ignoring comment-only lines. */
function countCallSites(absPath: string): number {
  const text = readFileSync(absPath, "utf8");
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    if (RANDOM_UUID_RE.test(line)) count += 1;
  }
  return count;
}

describe("architecture: no direct crypto.randomUUID() in src/", () => {
  const files = listSrcFiles().map((f) => ({
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    count: countCallSites(f),
  }));

  it("collected a non-trivial file set", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const f of files.filter((x) => x.rel !== RANDOM_ID_FILE)) {
    if (f.count === 0) continue;
    it(`${f.rel} has no direct crypto.randomUUID() call sites`, () => {
      expect(
        f.count,
        `${f.rel} has ${f.count} direct crypto.randomUUID() call site(s). ` +
          `Use randomUuid() from src/random-id.ts — crypto.randomUUID is ` +
          `undefined on non-secure origins (http://<lan-ip>) and throws.`,
      ).toBe(0);
    });
  }

  it("flags every offending file individually (none expected)", () => {
    const offenders = files
      .filter((x) => x.rel !== RANDOM_ID_FILE && x.count > 0)
      .map((x) => x.rel);
    expect(offenders).toEqual([]);
  });
});
