/**
 * Tests for `enrichSystemPromptForWorktree`.
 *
 * Verifies that the conditional worktree addendum is correctly appended
 * to the base prompt for both leader and minion roles, and that the base
 * content is preserved as a prefix (not replaced).
 */

import { describe, expect, it } from "vitest";
import { enrichSystemPromptForWorktree } from "./session-host-config.ts";

const FAKE_WORKTREE = {
  path: "/tmp/worktrees/feature-abc",
  branch: "wt/feature-abc",
  projectPath: "/home/user/myproject",
};

const BASE_LEADER = "Leader base prompt content.";
const BASE_MINION = "Minion base prompt content.";

describe("enrichSystemPromptForWorktree — leader", () => {
  const enriched = enrichSystemPromptForWorktree(BASE_LEADER, FAKE_WORKTREE, false);

  it("preserves the base prompt as a prefix", () => {
    expect(enriched.startsWith(BASE_LEADER)).toBe(true);
  });

  it("includes the worktree path and branch", () => {
    expect(enriched).toContain(FAKE_WORKTREE.path);
    expect(enriched).toContain(FAKE_WORKTREE.branch);
  });

  it("contains the request_approval instruction", () => {
    expect(enriched).toContain("request_approval");
  });

  it("contains the change-summary dashboard instruction", () => {
    // The leader must render a dashboard after calling request_approval
    expect(enriched).toContain("render_set");
    expect(enriched).toContain("Waiting for review");
  });

  it("contains the stop-and-wait instruction with all three user actions", () => {
    expect(enriched).toContain("Approve & Merge");
    expect(enriched).toContain("Discard");
    // Follow-up message = change request path
    expect(enriched).toMatch(/follow-up message|Send a.*message/i);
  });

  it("instructs leader to re-read files after a fresh worktree is provisioned", () => {
    expect(enriched).toMatch(/fresh worktree/i);
    expect(enriched).toMatch(/re-read|Re-read/);
  });

  it("labels the section 'Approval Workflow'", () => {
    expect(enriched).toContain("Approval Workflow");
  });
});

describe("enrichSystemPromptForWorktree — minion", () => {
  const enriched = enrichSystemPromptForWorktree(BASE_MINION, FAKE_WORKTREE, true);

  it("preserves the base prompt as a prefix", () => {
    expect(enriched.startsWith(BASE_MINION)).toBe(true);
  });

  it("includes the worktree path and branch", () => {
    expect(enriched).toContain(FAKE_WORKTREE.path);
    expect(enriched).toContain(FAKE_WORKTREE.branch);
  });

  it("instructs minion to commit before report_done", () => {
    expect(enriched).toMatch(/commit.*report_done|git add.*git commit/i);
  });

  it("instructs minion not to create branches, merge, rebase, or push", () => {
    expect(enriched).toMatch(/do not.*create branches|do NOT.*create branches/i);
    expect(enriched).toMatch(/merge|rebase|push/i);
  });

  it("does NOT include the leader Approval Workflow section", () => {
    expect(enriched).not.toContain("Approval Workflow");
    // request_approval is a leader-only tool; minions must not be told to call it
    expect(enriched).not.toContain("request_approval");
  });
});

describe("enrichSystemPromptForWorktree — appends, does not replace", () => {
  it("leader result is strictly longer than base", () => {
    const enriched = enrichSystemPromptForWorktree(BASE_LEADER, FAKE_WORKTREE, false);
    expect(enriched.length).toBeGreaterThan(BASE_LEADER.length);
  });

  it("minion result is strictly longer than base", () => {
    const enriched = enrichSystemPromptForWorktree(BASE_MINION, FAKE_WORKTREE, true);
    expect(enriched.length).toBeGreaterThan(BASE_MINION.length);
  });
});
