import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const COMMANDS_DIR = join(REPO_ROOT, "server", "commands");
const DIRECT_MERGE_RE = /\bmergeAndCleanup\s*\(/;
const RUN_MERGE_FLOW_IMPL_RE = /\bfunction\s+runMergeFlow\s*\(/;
const GATE_RE = /\bevaluateMergeGates\b/;

function listCommandFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(COMMANDS_DIR)) {
    const full = join(COMMANDS_DIR, entry);
    if (statSync(full).isFile() && entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("architecture: merge commands pass through system-model gates", () => {
  const files = listCommandFiles().map((path) => {
    const text = readFileSync(path, "utf8");
    return {
      rel: relative(REPO_ROOT, path).replace(/\\/g, "/"),
      requiresGate: DIRECT_MERGE_RE.test(text) || RUN_MERGE_FLOW_IMPL_RE.test(text),
      hasGate: GATE_RE.test(text),
    };
  });

  for (const file of files.filter((item) => item.requiresGate)) {
    it(`${file.rel} references evaluateMergeGates`, () => {
      expect(
        file.hasGate,
        `${file.rel} can merge a worktree and must call evaluateMergeGates.`,
      ).toBe(true);
    });
  }
});
