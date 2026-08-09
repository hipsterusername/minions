/**
 * Architecture fitness — @anthropic-ai/claude-agent-sdk isolated to server/harness/claude/.
 *
 * Design:
 *   - Files inside server/harness/claude/ may freely import the SDK.
 *   - Files outside that directory listed in SDK_IMPORT_ALLOWLIST are temporarily
 *     allowed; each entry generates a reminder test so the allowlist cannot
 *     go stale.
 *   - All other files must not import the SDK. A violation fails CI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const HARNESS_CLAUDE_DIR = join(REPO_ROOT, "server", "harness", "claude");

/**
 * Matches actual import/export statements that pull from the SDK.
 * Anchored at line-start (m flag) so it won't fire on comments or
 * string literals that happen to mention the package name.
 */
const SDK_IMPORT_RE =
  /^(?:import|export)\b[^\n]*\bfrom\s+['"]@anthropic-ai\/claude-agent-sdk['"]/m;

// Any SDK import outside server/harness/claude/ must be explicitly temporary.
const SDK_IMPORT_ALLOWLIST = new Set<string>();

// ── File discovery ────────────────────────────────────────────────────────────

const SEARCH_DIRS = ["server", "src", "shared", "tests"]
  .map((d) => join(REPO_ROOT, d))
  .filter(existsSync);

function listTsFiles(dirs: string[]): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  for (const dir of dirs) walk(dir);
  return out;
}

function isInsideHarnessClaude(absPath: string): boolean {
  const rel = relative(HARNESS_CLAUDE_DIR, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function hasSdkImport(absPath: string): boolean {
  return SDK_IMPORT_RE.test(readFileSync(absPath, "utf8"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const allFiles = listTsFiles(SEARCH_DIRS);
const outsideHarness = allFiles.filter((f) => !isInsideHarnessClaude(f));

describe("architecture: @anthropic-ai/claude-agent-sdk isolated to server/harness/claude/", () => {
  // Main gate: files not in the allowlist must not import the SDK.
  for (const absPath of outsideHarness) {
    const rel = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
    if (SDK_IMPORT_ALLOWLIST.has(rel)) continue;

    it(`${rel} does not import @anthropic-ai/claude-agent-sdk`, () => {
      expect(
        hasSdkImport(absPath),
        `${rel} imports @anthropic-ai/claude-agent-sdk directly. ` +
          `All SDK imports must live inside server/harness/claude/. ` +
          `If this is a temporary exception, add it to SDK_IMPORT_ALLOWLIST in this file.`,
      ).toBe(false);
    });
  }

  // Keep the temporary allowlist empty.
  it("keeps the SDK import allowlist empty", () => {
    expect(SDK_IMPORT_ALLOWLIST.size).toBe(0);
  });
});
