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
import {
  MINION_SYSTEM_PROMPT,
  ROLE_SYSTEM_PROMPT,
  appendRoleSystemPrompt,
} from "./minion-system.ts";

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
    expect(MINION_SYSTEM_PROMPT).not.toMatch(/Commit your work/);
  });

  it("still contains core role and status-tool instructions", () => {
    expect(MINION_SYSTEM_PROMPT).toContain("report_step");
    expect(MINION_SYSTEM_PROMPT).toContain("report_done");
    expect(MINION_SYSTEM_PROMPT).toContain("report_fail");
  });

  it("routes human questions through report_blocked and disclaims a native ask tool", () => {
    // Minions have no dashboard/form, so an Opus minion reaching for
    // AskUserQuestion must be redirected to report_blocked.
    expect(MINION_SYSTEM_PROMPT).toContain("AskUserQuestion");
    expect(MINION_SYSTEM_PROMPT).toMatch(/only channel for asking a question/i);
    expect(MINION_SYSTEM_PROMPT).toMatch(/report_blocked/);
  });

  it("instructs minions to keep final reports summary-first and reference artifact files", () => {
    expect(MINION_SYSTEM_PROMPT).toMatch(/under 2000 characters/i);
    expect(MINION_SYSTEM_PROMPT).toMatch(/file in the repo\/worktree/i);
    expect(MINION_SYSTEM_PROMPT).toMatch(/reference the path/i);
  });
});

describe("Role system beta prompt", () => {
  it("is byte-identical to the base prompt when disabled", () => {
    expect(appendRoleSystemPrompt(MINION_SYSTEM_PROMPT, false)).toBe(
      MINION_SYSTEM_PROMPT,
    );
  });

  it("adds the compact role contract when enabled", () => {
    const prompt = appendRoleSystemPrompt(MINION_SYSTEM_PROMPT, true);
    expect(prompt).toContain(ROLE_SYSTEM_PROMPT);
    expect(prompt).toMatch(/smallest sufficient expert role/i);
    expect(prompt).toMatch(/assignment supplies a role.*preserve its intent/is);
    expect(prompt).toMatch(/role never overrides/i);
    expect(prompt).toMatch(/facts, assumptions, inference, and judgment/i);
  });
});
