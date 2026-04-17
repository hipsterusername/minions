/**
 * Architecture fitness — no cross-tree imports.
 *
 * The refactor target is `src/` ↔ `server/` independence. Today there
 * is one tolerated import (server importing the minion system prompt
 * from src/prompts/), tracked in baselines.ts and slated for removal
 * in Phase 3.
 *
 * This test fails if:
 *   - `src/` imports anything from `../server/`
 *   - `server/` imports anything from `../src/` outside the documented
 *     allowlist
 *
 * See `docs/testing-strategy.md` §3 (L4) and `tests/architecture/baselines.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ALLOWED_CROSS_TREE_IMPORTS } from "./baselines.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

interface ImportHit {
  file: string;
  rel: string;
  line: number;
  text: string;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        walk(full);
      } else if (
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx")
      ) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function findCrossTreeImports(
  files: string[],
  pattern: RegExp,
): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (pattern.test(line)) {
        hits.push({
          file: f,
          rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }
  return hits;
}

describe("architecture: no cross-tree imports", () => {
  it("src/ does not import from ../server/", () => {
    const files = listSourceFiles(join(REPO_ROOT, "src"));
    const hits = findCrossTreeImports(files, /from\s+["']\.\.\/server\//);
    expect(
      hits,
      `Found cross-tree imports from src/ → server/:\n` +
        hits.map((h) => `  ${h.rel}:${h.line}  ${h.text}`).join("\n") +
        `\nThe client must not depend on server modules. Move shared code into shared/.`,
    ).toEqual([]);
  });

  it("server/ imports from ../src/ are limited to the documented allowlist", () => {
    const files = listSourceFiles(join(REPO_ROOT, "server"));
    const hits = findCrossTreeImports(files, /from\s+["']\.\.\/src\//);

    const unauthorised = hits.filter((h) => {
      return !ALLOWED_CROSS_TREE_IMPORTS.some((rule) => {
        const ruleRel = rule.file.replace(/\\/g, "/");
        return h.rel === ruleRel && rule.matcher.test(h.text);
      });
    });

    expect(
      unauthorised,
      `Found cross-tree imports from server/ → src/ that are NOT on the allowlist:\n` +
        unauthorised.map((h) => `  ${h.rel}:${h.line}  ${h.text}`).join("\n") +
        `\nEither remove the import or, if it's an intentional staging step, add ` +
        `an entry to ALLOWED_CROSS_TREE_IMPORTS in tests/architecture/baselines.ts ` +
        `with a note about which refactor phase will remove it.`,
    ).toEqual([]);
  });

  it("every allowlisted cross-tree import is still present (otherwise drop the entry)", () => {
    const files = listSourceFiles(join(REPO_ROOT, "server"));
    const hits = findCrossTreeImports(files, /from\s+["']\.\.\/src\//);

    for (const rule of ALLOWED_CROSS_TREE_IMPORTS) {
      const ruleRel = rule.file.replace(/\\/g, "/");
      const found = hits.some(
        (h) => h.rel === ruleRel && rule.matcher.test(h.text),
      );
      expect(
        found,
        `Allowlist entry ${rule.file} (${rule.matcher}) no longer matches anything ` +
          `in the source. Remove it from ALLOWED_CROSS_TREE_IMPORTS.`,
      ).toBe(true);
    }
  });
});
