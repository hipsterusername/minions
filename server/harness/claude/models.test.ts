import { describe, expect, it } from "vitest";
import { resolveModelAlias, supportsAdaptiveThinking } from "./models.ts";

describe("Claude model metadata", () => {
  it("resolves the Fable 5 alias to the concrete SDK model id", () => {
    expect(resolveModelAlias("fable")).toBe("claude-fable-5");
  });

  it("marks Fable 5 as adaptive-thinking capable", () => {
    expect(supportsAdaptiveThinking("fable")).toBe(true);
    expect(supportsAdaptiveThinking("claude-fable-5")).toBe(true);
  });
});
