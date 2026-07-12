/**
 * Architecture fitness — no test writes to the developer's real home dir.
 *
 * `server/project-store.ts` captures `os.homedir()` at module-load time.
 * Any test that imports it (transitively) and exercises `addRecentProject`
 * will land entries in the real `~/.minions/recent-projects.json`
 * unless `node:os` is mocked first.
 *
 * Concretely: contract tests that mount `server/routes/projects/core.ts`
 * (which calls `addRecentProject`) MUST install a `vi.mock("node:os", …)`
 * factory that swaps `homedir()` for a tmpdir. We've been bitten once —
 * a contract suite created phantom "test" projects in the user's recent
 * list, mirrored straight into the live app UI.
 *
 * This test enforces the invariant by walking every file under
 * `tests/contracts/` and `tests/harness/` and asserting:
 *
 *   IF the file imports `mountCoreRoutes` from `server/routes/projects/core.ts`
 *      OR imports `addRecentProject` / `removeRecentProject` directly,
 *   THEN the file MUST also contain a `vi.mock("node:os"` factory.
 *
 * The check is intentionally textual — fast, no AST traversal needed.
 * False positives are easy to silence by adding the mock; false negatives
 * (a test smuggling in a write through some other path) are out of scope
 * here and would surface as user-visible pollution.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const TEST_ROOTS = [
  join(REPO_ROOT, "tests", "contracts"),
  join(REPO_ROOT, "tests", "harness"),
];

/** Imports that pull `addRecentProject` (directly or via the route mount). */
const RISKY_IMPORTS = [
  /from ["']\.\.\/\.\.\/server\/routes\/projects\/core(\.ts)?["']/,
  /from ["']\.\.\/\.\.\/server\/project-store(\.ts)?["']/,
];

/** A `vi.mock("node:os", …)` factory in any quoting style. */
const OS_MOCK_RE = /vi\.mock\(\s*["']node:os["']/;

function listTestFiles(roots: string[]): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
        out.push(full);
      }
    }
  }
  for (const root of roots) {
    try {
      walk(root);
    } catch {
      /* root may not exist on partial checkouts — ignore */
    }
  }
  return out;
}

function isRiskyFile(content: string): boolean {
  // Only flag files that ALSO mention addRecentProject downstream of the
  // mount — opening project-store for read-only helpers (e.g. initSidecar
  // in the settings-routes test) is fine.
  for (const re of RISKY_IMPORTS) {
    if (!re.test(content)) continue;
    if (
      content.includes("mountCoreRoutes") ||
      content.includes("addRecentProject") ||
      content.includes("removeRecentProject")
    ) {
      return true;
    }
  }
  return false;
}

describe("architecture: no real-home writes from tests", () => {
  it("every test that mounts the core project routes mocks node:os", () => {
    const files = listTestFiles(TEST_ROOTS);
    const violators: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (!isRiskyFile(content)) continue;
      if (!OS_MOCK_RE.test(content)) {
        violators.push(relative(REPO_ROOT, file));
      }
    }
    expect(violators).toEqual([]);
  });
});
