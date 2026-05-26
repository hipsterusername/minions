/**
 * Architecture fitness — @anthropic-ai/claude-agent-sdk isolated to server/harness/claude/.
 *
 * Phase 2 achievement: server/session-host.ts no longer imports the SDK.
 * Phase 4 will migrate the remaining tool-definition files.
 *
 * Design:
 *   - Files inside server/harness/claude/ may freely import the SDK.
 *   - Files outside that directory listed in PHASE_4_PENDING are still
 *     allowed for now; each entry generates a reminder test so the
 *     allowlist can't go stale — when Phase 4 cleans a file up, the
 *     corresponding test here starts failing until the entry is removed.
 *   - All other files must not import the SDK. A violation fails CI.
 *
 * See docs/model-agnosticism-spec.md §3.1 and Phase 2.
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

// ── Phase 4 pending ───────────────────────────────────────────────────────────
// Phase 4 complete — all tool files have been migrated to NormalizedToolDef.
// The allowlist is now empty. Any new file that accidentally imports the SDK
// outside server/harness/claude/ will be caught by the main gate below.
const PHASE_4_PENDING = new Set<string>();

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
    if (PHASE_4_PENDING.has(rel)) continue;

    it(`${rel} does not import @anthropic-ai/claude-agent-sdk`, () => {
      expect(
        hasSdkImport(absPath),
        `${rel} imports @anthropic-ai/claude-agent-sdk directly. ` +
          `All SDK imports must live inside server/harness/claude/. ` +
          `If this is a Phase 4 migration target, add it to PHASE_4_PENDING in this file.`,
      ).toBe(false);
    });
  }

  // Phase 4 is complete: the allowlist is empty. This test confirms it stays
  // that way — any future file added to PHASE_4_PENDING by mistake will fail
  // the main gate above without needing this secondary check.
  it("PHASE_4_PENDING allowlist is empty — Phase 4 migration complete", () => {
    expect(PHASE_4_PENDING.size).toBe(0);
  });
});
