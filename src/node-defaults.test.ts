import { describe, expect, it } from "vitest";
import { applyPromptSeed, createDefaultNodeData } from "./node-defaults.ts";
import type { ThinkingConfig } from "./types.ts";

describe("createDefaultNodeData leader thinking defaults", () => {
  it("applies the project sandbox default to new leaders", () => {
    const sandboxPolicy = {
      filesystemScope: "read-only" as const,
      approvalPolicy: "always" as const,
    };
    const data = createDefaultNodeData("leader", {
      defaultSandboxPolicy: sandboxPolicy,
    }) as { sandboxPolicy: typeof sandboxPolicy };

    expect(data.sandboxPolicy).toEqual(sandboxPolicy);
    expect(data.sandboxPolicy).not.toBe(sandboxPolicy);
  });

  it("defaults fable leaders to medium thinking effort", () => {
    const data = createDefaultNodeData("leader", {
      defaultLeaderModel: "claude-fable-5",
    }) as { thinkingConfig: ThinkingConfig };

    expect(data.thinkingConfig.effort).toBe("medium");
  });

  it("keeps opus leaders on the existing high thinking default", () => {
    const data = createDefaultNodeData("leader", {
      defaultLeaderModel: "claude-opus-4-8",
    }) as { thinkingConfig: ThinkingConfig };

    expect(data.thinkingConfig.effort).toBe("high");
  });

  it("preserves an explicit user thinking effort for fable leaders", () => {
    const data = createDefaultNodeData("leader", {
      defaultLeaderModel: "fable",
      defaultLeaderThinkingConfig: {
        enabled: true,
        effort: "xhigh",
        display: "summarized",
      },
    }) as { thinkingConfig: ThinkingConfig };

    expect(data.thinkingConfig.effort).toBe("xhigh");
  });
});

describe("applyPromptSeed", () => {
  it("auto-starts a leader with the typed prompt", () => {
    const data = applyPromptSeed("leader", { model: "opus" }, "build a thing");
    expect(data).toEqual({ model: "opus", autoStartPrompt: "build a thing" });
  });

  it("seeds markdown content and derives a title from the first line", () => {
    const data = applyPromptSeed(
      "markdown",
      createDefaultNodeData("markdown"),
      "My heading\nbody text",
    ) as { content: string; title: string };
    expect(data.content).toBe("My heading\nbody text");
    expect(data.title).toBe("My heading");
  });

  it("seeds note text and file/folder paths", () => {
    expect(applyPromptSeed("note", {}, "todo")).toEqual({ text: "todo" });
    expect(applyPromptSeed("file-viewer", {}, "src/a.ts")).toEqual({
      filePath: "src/a.ts",
    });
    expect(applyPromptSeed("folder", {}, "src")).toEqual({ folderPath: "src" });
  });

  it("returns data untouched for a blank value", () => {
    const original = { title: "Untitled", content: "" };
    expect(applyPromptSeed("markdown", original, "   ")).toBe(original);
  });

  it("returns data untouched for types with nowhere to put text", () => {
    const original = { sessionKey: null };
    expect(applyPromptSeed("claude-session", original, "hi")).toBe(original);
  });
});
