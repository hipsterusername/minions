/**
 * Architecture fitness — banned assertion patterns in tests.
 *
 * Per `docs/testing-strategy.md` §6.3, the following matchers are banned
 * in test code because they cannot fail on a real regression:
 *
 *   - `getBy*(...).toBeDefined()` — `getBy*` throws on miss; the matcher
 *     applied to its result can never fail. The query already IS the
 *     assertion.
 *   - `getBy*(...).toBeTruthy()` — same as above.
 *   - `getByTestId(...).toBeDefined()` / `.toBeTruthy()` — same.
 *   - Inline-style assertions like `style.toMatch(/flex/)` — couples the
 *     test to the implementation's CSS choice, breaks on any equivalent
 *     refactor that moves layout to a class.
 *   - CSS-token coupling like `getAttribute("style").toContain("--token-")` —
 *     same anti-pattern, different vector.
 *
 * Anything matched here either replaces with a meaningful matcher (e.g.
 * `toHaveTextContent(...)`, `toHaveAttribute(...)`, drop the matcher
 * entirely so the query is the assertion) or carries an explicit
 * `// BANNED_ASSERTION_OK: <reason>` comment on the same line.
 *
 * The rules are intentionally narrow regexes — the goal is precision, not
 * recall. Anti-patterns that aren't catchable by a regex (mock-of-self,
 * schema redundancy) live in the gap document, not here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const TEST_GLOBS = ["server", "src", "shared", "tests"] as const;

interface BannedRule {
  /** Stable id used in waiver comments. */
  id: string;
  /** One-sentence description shown in the failure message. */
  description: string;
  /** Per-line regex; must include the `g` flag. */
  pattern: RegExp;
  /** Strategy doc anchor that explains the rule. */
  rule: string;
}

const RULES: ReadonlyArray<BannedRule> = [
  {
    id: "getBy-toBeDefined",
    description:
      "`getBy*(...).toBeDefined()` — getBy* throws on miss; matcher cannot fail.",
    pattern: /getBy[A-Z][A-Za-z]*\([^)]*\)\.toBeDefined\(\)/g,
    rule: "§5.5 (TRIVIAL)",
  },
  {
    id: "getBy-toBeTruthy",
    description:
      "`getBy*(...).toBeTruthy()` — getBy* throws on miss; matcher cannot fail.",
    pattern: /getBy[A-Z][A-Za-z]*\([^)]*\)\.toBeTruthy\(\)/g,
    rule: "§5.5 (TRIVIAL)",
  },
  {
    id: "style-flex-toMatch",
    description:
      "Asserting on inline-style flex strings — couples test to CSS implementation.",
    pattern: /\.style[A-Za-z.]*\.toMatch\([^)]*flex[^)]*\)/g,
    rule: "§5.5 (IMPL_COUPLING)",
  },
  {
    id: "css-token-toContain",
    description:
      "`getAttribute(\"style\").toContain(\"--token-...\")` — couples test to CSS variable name.",
    pattern: /getAttribute\(\s*["']style["']\s*\)\.toContain\(\s*["']--/g,
    rule: "§5.5 (IMPL_COUPLING)",
  },
] as const;

const WAIVER_COMMENT = /\/\/\s*BANNED_ASSERTION_OK:\s*\S/;

function listTestFiles(): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") {
        continue;
      }
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
        out.push(full);
      }
    }
  }

  for (const top of TEST_GLOBS) {
    walk(join(REPO_ROOT, top));
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
  rule: BannedRule;
}

function scanForRule(rule: BannedRule, abs: string): Hit[] {
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Reset regex state because we use the `g` flag.
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(line)) continue;
    if (WAIVER_COMMENT.test(line)) continue;
    // Skip removal-trail comments. A test author may have left
    // `// Removed three getByText(...).toBeTruthy() smoke checks`
    // behind to document the cleanup.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    hits.push({
      file: relative(REPO_ROOT, abs).replace(/\\/g, "/"),
      line: i + 1,
      text: line.trim(),
      rule,
    });
  }
  return hits;
}

describe("architecture: no banned assertion patterns in tests", () => {
  const files = listTestFiles();

  it("scans at least one test file (sanity for the walker)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const rule of RULES) {
    it(`no test file contains ${rule.id}`, () => {
      const hits = files.flatMap((f) => scanForRule(rule, f));
      if (hits.length === 0) return;
      const detail = hits
        .map((h) => `  ${h.file}:${h.line} — ${h.text}`)
        .join("\n");
      expect(
        hits,
        [
          `Found ${hits.length} occurrence(s) of banned pattern "${rule.id}".`,
          rule.description,
          `Strategy: docs/testing-strategy.md ${rule.rule}.`,
          ``,
          `If a specific occurrence is unavoidable, add an inline waiver:`,
          `  // BANNED_ASSERTION_OK: <reason>`,
          ``,
          `Locations:`,
          detail,
        ].join("\n"),
      ).toEqual([]);
    });
  }
});
