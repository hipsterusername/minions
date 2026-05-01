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
import { join, relative } from "node:path";

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
// Files outside server/harness/claude/ that still import the SDK.
// Each will be migrated to NormalizedToolDef in Phase 4; remove the entry
// once the import is gone. Leaving a stale entry here causes the sanity
// check below to fail.
const PHASE_4_PENDING = new Set([
  "server/render-tools.ts",
  "server/render-tools.test.ts",
  "server/minion-tools.ts",
  "server/minion-tools.test.ts",
  "server/multimodal-prompt.ts",
  "server/task-tools.ts",
  "server/task-tools/assign-task.ts",
  "server/task-tools/complete-task.ts",
  "server/task-tools/get-task-status.ts",
  "server/task-tools/plan-task.ts",
  "server/task-tools/request-approval.ts",
  "server/task-tools/set-task-name.ts",
  "server/task-tools/wait-and-continue.ts",
  "server/routines/step-tools.ts",
]);

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
  return absPath.startsWith(HARNESS_CLAUDE_DIR + "/");
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

  // Sanity check: every PHASE_4_PENDING entry must still import the SDK.
  // When Phase 4 removes an import, this test fails until the entry is
  // removed from PHASE_4_PENDING — keeping the allowlist honest.
  describe("PHASE_4_PENDING allowlist is current (no stale entries)", () => {
    for (const pending of PHASE_4_PENDING) {
      it(`${pending} still imports the SDK (remove from allowlist when migrated)`, () => {
        const absPath = join(REPO_ROOT, pending);
        if (!existsSync(absPath)) {
          expect.fail(
            `PHASE_4_PENDING entry "${pending}" does not exist. ` +
              `Remove it from the allowlist.`,
          );
          return;
        }
        expect(
          hasSdkImport(absPath),
          `PHASE_4_PENDING entry "${pending}" no longer imports the SDK. ` +
            `Remove it from the allowlist in this file.`,
        ).toBe(true);
      });
    }
  });
});
