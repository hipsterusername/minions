/**
 * Architecture fitness — banned assertion shapes.
 *
 * Per `docs/testing-strategy.md` §6.3: the test tree must NOT contain
 * assertions where the query already carries the signal and the matcher
 * adds no information.
 *
 * Banned shapes:
 *   1. `getBy*(...).toBeDefined()` / `getBy*(...).toBeTruthy()` —
 *      `getBy*` throws when no element matches, so the matcher is dead
 *      weight. Either the query is the assertion (drop the matcher) or
 *      the test should assert something falsifiable (visible text, a
 *      callback, a state change).
 *   2. CSS-style implementation coupling — `toHaveStyle({ display: ... })`,
 *      reads of `getComputedStyle(...)`, or attribute-only checks
 *      (`data-no-drag`, inline `style=`) that pin presentation rather
 *      than behaviour.
 *
 * If a real test needs one of these patterns, justify it with an inline
 * `// BANNED_ASSERTION_OK: <reason>` comment on the same line; the
 * scanner skips lines carrying that marker.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SCAN_ROOTS = ["src", "server", "shared", "tests"];

interface Violation {
  rel: string;
  line: number;
  text: string;
  rule: "QUERY_AS_ASSERTION" | "CSS_COUPLING";
}

/** All `*.test.ts` and `*.test.tsx` files under the scan roots. */
function listTestFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(join(REPO_ROOT, root), out);
  }
  return out;
}

function walk(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, acc);
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      acc.push(full);
    }
  }
}

/**
 * `expect(<getBy*|queryBy*|findBy*>(...)).toBe(Defined|Truthy)()` is
 * the canonical "the query is the assertion" anti-pattern. Match the
 * full chain on a single line so multiline formatting decisions don't
 * trip the scanner.
 */
const QUERY_AS_ASSERTION_RE =
  /expect\([^)]*\b(?:getBy|queryBy|findBy)[A-Z]\w*\([^)]*\)[^)]*\)\s*\.\s*(?:toBeDefined|toBeTruthy)\s*\(\s*\)/;

/**
 * CSS / DOM-impl coupling: `.toHaveStyle({...})` with a literal style
 * object, raw `getComputedStyle(...)` reads, and bare attribute-only
 * `getAttribute("style")` reads. These pin presentation, not behaviour.
 */
const CSS_COUPLING_RES: ReadonlyArray<RegExp> = [
  /\.toHaveStyle\s*\(\s*\{/,
  /getComputedStyle\s*\(/,
  /\.getAttribute\s*\(\s*["']style["']\s*\)/,
];

/** A line carrying this marker is allowed to violate either rule. */
const ESCAPE_HATCH_RE = /BANNED_ASSERTION_OK:/;

/**
 * Lines that are clearly comments — `//`, `/*`, `*` continuation, or a
 * trailing `// ...` after code. Block-comment scanning isn't perfect,
 * but it's good enough to keep the lint from tripping on its own
 * documentation that quotes the banned patterns.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function scanFile(path: string): Violation[] {
  const text = readFileSync(path, "utf8");
  const rel = relative(REPO_ROOT, path).replace(/\\/g, "/");
  const lines = text.split("\n");
  const out: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (ESCAPE_HATCH_RE.test(line)) continue;
    if (isCommentLine(line)) continue;

    if (QUERY_AS_ASSERTION_RE.test(line)) {
      out.push({
        rel,
        line: i + 1,
        text: line.trim(),
        rule: "QUERY_AS_ASSERTION",
      });
      continue;
    }

    for (const re of CSS_COUPLING_RES) {
      if (re.test(line)) {
        out.push({
          rel,
          line: i + 1,
          text: line.trim(),
          rule: "CSS_COUPLING",
        });
        break;
      }
    }
  }

  return out;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  [${v.rule}] ${v.rel}:${v.line}\n    ${v.text}`)
    .join("\n");
}

describe("architecture: banned assertion shapes", () => {
  const files = listTestFiles();

  it("the test tree contains no `getBy*().toBeDefined()` / `toBeTruthy()` shapes (§6.3)", () => {
    const all = files.flatMap(scanFile);
    const offenders = all.filter((v) => v.rule === "QUERY_AS_ASSERTION");
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Found ${offenders.length} query-as-assertion violation(s). The query already throws on absence — drop the matcher or assert something falsifiable instead.\n\n${formatViolations(offenders)}\n\nIf the call site is genuinely correct, mark it with \`// BANNED_ASSERTION_OK: <reason>\` on the same line.`,
    ).toEqual([]);
  });

  it("the test tree contains no CSS-style implementation coupling (§5.5 IMPL_COUPLING)", () => {
    const all = files.flatMap(scanFile);
    const offenders = all.filter((v) => v.rule === "CSS_COUPLING");
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Found ${offenders.length} CSS-style coupling violation(s). Tests must assert behaviour, not computed styles or inline-style attributes.\n\n${formatViolations(offenders)}\n\nIf the assertion is genuinely about a behaviour proxy (e.g. \`display:none\` proves something is hidden), mark it with \`// BANNED_ASSERTION_OK: <reason>\` on the same line.`,
    ).toEqual([]);
  });
});
