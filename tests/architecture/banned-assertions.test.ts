/**
 * Architecture fitness — banned assertion shapes.
 *
 * The test tree must not contain assertions where the query already carries
 * the signal and the matcher adds no information.
 *
 * Banned shapes:
 *   1. `getBy*(...).toBeDefined()` / `getBy*(...).toBeTruthy()` —
 *      `getBy*` throws when no element matches, so the matcher is dead
 *      weight. Either the query is the assertion (drop the matcher) or
 *      the test should assert something falsifiable (visible text, a
 *      callback, a state change).
 * Layout and computed-style assertions are intentionally allowed: geometry,
 * visibility, and readable contrast are behavior in a spatial application.
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
  rule: "QUERY_AS_ASSERTION";
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
 * `expect(<getBy*>(...)).toBe(Defined|Truthy)()` is
 * the canonical "the query is the assertion" anti-pattern. Match the
 * full chain on a single line so multiline formatting decisions don't
 * trip the scanner.
 */
const QUERY_AS_ASSERTION_RE =
  /expect\([^)]*\bgetBy[A-Z]\w*\([^)]*\)[^)]*\)\s*\.\s*(?:toBeDefined|toBeTruthy)\s*\(\s*\)/;

/** A line carrying this marker is allowed to violate the rule. */
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

  it("scans at least one test file (sanity for the walker)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

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
});
