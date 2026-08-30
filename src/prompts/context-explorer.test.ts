import { describe, expect, it } from "vitest";
import { CONTEXT_EXPLORER_PROMPT } from "./context-explorer.ts";

describe("CONTEXT_EXPLORER_PROMPT", () => {
  it("requires the workspace context tool instead of a repository file", () => {
    const prompt = CONTEXT_EXPLORER_PROMPT("/project");

    expect(prompt).toContain("call `update_project_context` exactly once");
    expect(prompt).toContain("subsequently delegated Minion agents");
    expect(prompt).toContain("Do not create or edit `context.md`, `CLAUDE.md`");
    expect(prompt).not.toMatch(/produce a context\.md/i);
  });
});
