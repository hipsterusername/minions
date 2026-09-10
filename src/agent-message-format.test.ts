import { describe, expect, it } from "vitest";
import { agentJsonText, agentMessagePreview, parseAgentJson } from "./agent-message-format.ts";

describe("agent message previews", () => {
  it("makes all report fields readable for an expanded report", () => {
    expect(agentJsonText({ summary: "Tests passed", next_steps: ["Review", "Merge"],
      checks: { count: 0, skipped: false, reason: null } })).toBe(
      "Summary: Tests passed\nNext steps: Review\nMerge\nChecks: Count: 0\nSkipped: false\nReason: null",
    );
  });

  it("unwraps nested JSON without dropping metadata", () => {
    expect(agentJsonText({ summary: JSON.stringify({ message: "Done" }), id: "task-1" }))
      .toBe("Summary: Message: Done\nId: task-1");
  });

  it.each([
    JSON.stringify({ summary: "Long operational evidence", artifact: "artifact_private" }),
    JSON.stringify(JSON.stringify({ message: "Long operational evidence" })),
    JSON.stringify([{ summary: "Long operational evidence" }]),
  ])("keeps report evidence out of session previews: %s", text => {
    expect(agentMessagePreview(text)).toBe("Agent report available. Open session to view details.");
  });

  it.each(["Normal **Markdown**", '{"summary":"partial', '```json\n{"summary":"Example"}\n```'])
  ("preserves prose, partial JSON, and code examples: %s", text => {
    expect(parseAgentJson(text)).toBeNull();
    expect(agentMessagePreview(text)).toBe(text);
  });
});
