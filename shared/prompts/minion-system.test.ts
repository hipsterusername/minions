/**
 * Tests for the base MINION_SYSTEM_PROMPT.
 *
 * The static minion prompt must be harness-agnostic. Worktree-specific
 * rules (commit-before-done, path isolation, no-branch/merge/push) are
 * injected conditionally by `enrichSystemPromptForWorktree` only when a
 * worktree is active. The static prompt must not make unconditional
 * worktree claims.
 */

import { describe, expect, it } from "vitest";
import { MINION_SYSTEM_PROMPT } from "./minion-system.ts";

describe("MINION_SYSTEM_PROMPT (base)", () => {
  it("does NOT claim the agent is working inside a git worktree", () => {
    // The phrase "You are working inside a **git worktree**" was an unconditional
    // lie for non-isolated minions. It must no longer appear in the base prompt.
    expect(MINION_SYSTEM_PROMPT).not.toMatch(/working inside a \*\*git worktree\*\*/i);
    expect(MINION_SYSTEM_PROMPT).not.toMatch(/You are working inside a.*git worktree/i);
  });

  it("does NOT contain 'Commit Before Reporting Done' section", () => {
    expect(MINION_SYSTEM_PROMPT).not.toContain("Commit Before Reporting Done");
  });

  it("does NOT contain 'Git & Worktree Rules' section header", () => {
    expect(MINION_SYSTEM_PROMPT).not.toContain("Git & Worktree Rules");
  });

  it("contains the generic safe-git bullet in Guidelines", () => {
    // The bullet warns minions not to run destructive git ops unless a
    // worktree section explicitly authorises them.
    expect(MINION_SYSTEM_PROMPT).toMatch(/do not commit.*branch.*merge.*rebase.*push/i);
    expect(MINION_SYSTEM_PROMPT).toMatch(/shared working tree/i);
  });

  it("does NOT instruct 'Commit your work' in the role steps", () => {
    // Step 4 used to say "Commit your work before reporting completion", which
    // contradicted the Safe git guideline. It must be gone.
    expect(MINION_SYSTEM_PROMPT).not.toMatch(/Commit your work/);
  });

  it("still contains core role and status-tool instructions", () => {
    expect(MINION_SYSTEM_PROMPT).toContain("report_step");
    expect(MINION_SYSTEM_PROMPT).toContain("report_done");
    expect(MINION_SYSTEM_PROMPT).toContain("report_fail");
  });
});
