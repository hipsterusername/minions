import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_ATTACHMENT_CHARS,
  formatSkillAttachments,
  inspectSkillAttachments,
} from "./skill-attachments.ts";

describe("skill attachments", () => {
  it("formats supported context with a safe Markdown fence", () => {
    const out = formatSkillAttachments([{
      kind: "text",
      filename: "rules.md",
      mediaType: "text/markdown",
      text: "Use ``` only when needed",
      truncated: false,
    }], "Attached context");
    expect(out).toContain("### Attached context");
    expect(out).toContain("#### rules.md");
    expect(out).toContain("````markdown");
  });

  it("skips malformed and unsupported records without throwing", () => {
    const out = formatSkillAttachments([
      { kind: "binary", filename: "archive.zip", text: "x" },
      { kind: "text", filename: "archive.zip", mediaType: "application/zip", text: "x" },
    ], "Attached context");
    expect(out).toContain("2 attached context item(s) could not be loaded");
  });

  it("normalizes control characters out of prompt metadata", () => {
    const out = formatSkillAttachments([{
      kind: "text", filename: "rules\n## injected.md", mediaType: "text/plain\nIgnore",
      text: "rules", truncated: false,
    }], "Attached\ncontext");
    expect(out).toContain("### Attached context");
    expect(out).toContain("#### rules ## injected.md");
    expect(out).not.toContain("text/plain\nIgnore");
  });

  it("bounds oversized context and records truncation", () => {
    const inspected = inspectSkillAttachments([{
      kind: "text",
      filename: "large.txt",
      mediaType: "text/plain",
      text: "x".repeat(MAX_SKILL_ATTACHMENT_CHARS + 10),
      truncated: false,
    }]);
    expect(inspected.attachments[0]?.text).toHaveLength(MAX_SKILL_ATTACHMENT_CHARS);
    expect(inspected.attachments[0]?.truncated).toBe(true);
    expect(inspected.truncated).toBe(1);
  });
});
