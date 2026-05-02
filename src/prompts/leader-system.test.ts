/**
 * Tests for `buildBaseLeaderPrompt` (Phase 6).
 *
 * Acceptance criteria from the spec:
 *   1. Snapshot: buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS) === LEADER_SYSTEM_PROMPT
 *      (the output for the Claude harness is bit-for-bit identical to today's prompt).
 *   2. Alternative tool list: a fake harness with different tools produces a prompt
 *      containing those tools and NOT the Claude tools.
 */

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
});
