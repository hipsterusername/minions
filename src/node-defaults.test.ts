import { describe, expect, it } from "vitest";
import { createDefaultNodeData } from "./node-defaults.ts";
import type { ThinkingConfig } from "./types.ts";

describe("createDefaultNodeData leader thinking defaults", () => {
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
