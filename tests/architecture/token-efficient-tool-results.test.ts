/**
 * Architecture fitness — tool results must stay token-efficient.
 *
 * Every byte a tool handler returns is streamed into an agent's context and
 * then re-paid on every subsequent turn. Two rules keep that cost down, both
 * enforced here across all server tool modules (files exporting
 * NormalizedToolDef factories):
 *
 *  1. No pretty-printed JSON in tool results. `JSON.stringify(x, null, N)`
 *     roughly doubles the token count of structured payloads. Use
 *     `jsonResult` / `compactJson` from `server/harness/tool-result.ts`.
 *
 *  2. No hand-rolled `{ content: [{ type: "text", ... }] }` literals.
 *     Results must be built via the `server/harness/tool-result.ts` helpers
 *     (`okResult`, `textResult`, `errorResult`, `jsonResult`) so the
 *     token-efficiency conventions have a single enforcement point.
 *
 * See `docs/testing-strategy.md` §3 (L4).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Server modules that define MCP tool handlers for agents. */
const TOOL_MODULE_DIRS = [join(REPO_ROOT, "server", "task-tools")];
const TOOL_MODULE_FILES = [
  join(REPO_ROOT, "server", "minion-tools.ts"),
  join(REPO_ROOT, "server", "render-tools.ts"),
];

/** The helper module itself is the one place allowed to build raw results. */
const HELPER_FILE = "server/harness/tool-result.ts";

/** Pretty-printed stringify: `JSON.stringify(<anything>, null, <indent>)`. */
const PRETTY_PRINT_RE = /JSON\.stringify\s*\([^;]*?,\s*null\s*,\s*\d/gs;

/** Hand-rolled result literal: `content: [{ type: "text"...` */
const RAW_RESULT_RE = /content:\s*\[\s*\{\s*type:\s*"text"/g;

function listToolModules(): string[] {
  const out: string[] = [...TOOL_MODULE_FILES];
  for (const dir of TOOL_MODULE_DIRS) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile() && entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

function countMatches(absPath: string, re: RegExp): number {
  const text = readFileSync(absPath, "utf8");
  return (text.match(re) ?? []).length;
}

describe("architecture: token-efficient tool results", () => {
  const files = listToolModules().map((f) => ({
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    prettyPrints: countMatches(f, PRETTY_PRINT_RE),
    rawResults: countMatches(f, RAW_RESULT_RE),
  }));

  it("scans the expected tool-module surface", () => {
    // Guard against the walk silently matching nothing.
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const f of files) {
    it(`${f.rel} has no pretty-printed JSON.stringify in results`, () => {
      expect(
        f.prettyPrints,
        `${f.rel} pretty-prints JSON (${f.prettyPrints} site(s)). ` +
          `Use jsonResult/compactJson from ${HELPER_FILE} — indentation ` +
          `roughly doubles the token cost of structured tool results.`,
      ).toBe(0);
    });

    it(`${f.rel} builds results via the tool-result helpers`, () => {
      expect(
        f.rawResults,
        `${f.rel} hand-rolls ${f.rawResults} result literal(s). ` +
          `Use okResult/textResult/errorResult/jsonResult from ${HELPER_FILE} ` +
          `so token-efficiency conventions stay enforceable in one place.`,
      ).toBe(0);
    });
  }
});
