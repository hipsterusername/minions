import { describe, expect, it } from "vitest";
import {
  buildBaseLeaderPrompt,
  CLAUDE_BUILT_IN_TOOLS,
  LEADER_SYSTEM_PROMPT,
} from "./leader-system.ts";

describe("buildBaseLeaderPrompt", () => {
  it("equals LEADER_SYSTEM_PROMPT when called with CLAUDE_BUILT_IN_TOOLS (snapshot)", () => {
    expect(buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS)).toBe(LEADER_SYSTEM_PROMPT);
  });

  it("injects the given tool names into the capabilities section", () => {
    const tools = ["FakeRead", "FakeWrite", "FakeExec"];
    const prompt = buildBaseLeaderPrompt(tools);
    expect(prompt).toContain("FakeRead, FakeWrite, FakeExec");
  });

  it("does NOT include Claude tool names when a different list is passed", () => {
    const prompt = buildBaseLeaderPrompt(["SpecialTool"]);
    // The hardcoded Claude list must not appear when overridden
    expect(prompt).not.toContain("Read, Write, Edit, Bash");
    expect(prompt).toContain("SpecialTool");
  });

  it("LEADER_SYSTEM_PROMPT constant contains the default Claude tool names", () => {
    for (const tool of CLAUDE_BUILT_IN_TOOLS) {
      expect(LEADER_SYSTEM_PROMPT).toContain(tool);
    }
  });

  // Worktree/approval copy must NOT appear in the base prompt — it is
  // injected conditionally by enrichSystemPromptForWorktree only when
  // a worktree is actually active.
  it("base leader prompt does NOT contain request_approval", () => {
    expect(buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS)).not.toContain("request_approval");
  });

  it("base leader prompt does NOT contain 'Worktree Isolation'", () => {
    expect(buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS)).not.toContain("Worktree Isolation");
  });

  it("base leader prompt does NOT contain 'Approval Workflow'", () => {
    expect(buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS)).not.toContain("Approval Workflow");
  });

  it("explicitly disclaims a native AskUserQuestion tool so Opus agents stop reaching for it", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("AskUserQuestion");
    expect(LEADER_SYSTEM_PROMPT).toMatch(/no `AskUserQuestion` tool/i);
  });

  it("keeps ask-user guidance in the stable core before generated capabilities", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("## Asking the User a Question");
    expect(LEADER_SYSTEM_PROMPT).toMatch(/render a `form`/i);
    expect(LEADER_SYSTEM_PROMPT.indexOf("## Asking the User a Question")).toBeLessThan(
      LEADER_SYSTEM_PROMPT.indexOf("## Your Capabilities"),
    );
  });

  it("offers Task Graph by default without removing direct Leader tools", () => {
    expect(LEADER_SYSTEM_PROMPT).toContain("## Task Graph planning");
    expect(LEADER_SYSTEM_PROMPT).toContain("`/graph` and `/crew`");
    expect(LEADER_SYSTEM_PROMPT).toContain("submit_graph_plan");
    expect(LEADER_SYSTEM_PROMPT).toContain("assign_task");
    expect(LEADER_SYSTEM_PROMPT).toMatch(/always enabled and is the standard Minion execution path/i);
    expect(LEADER_SYSTEM_PROMPT).not.toContain("## Legacy planning mode (debug)");
    const legacyPrompt = buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS, "direct");
    expect(legacyPrompt).toBe(LEADER_SYSTEM_PROMPT);
    // The old 60-second polling example must be gone.
    expect(legacyPrompt).not.toMatch(/wait_and_continue.*60 seconds/i);
    expect(legacyPrompt).not.toContain("## Compatibility planning");
    expect(legacyPrompt).toContain("## Task Graph planning");
  });
});
