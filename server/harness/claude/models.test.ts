import { describe, expect, it } from "vitest";
import { CLAUDE_MODEL_POLICY, resolveModelAlias, supportsAdaptiveThinking } from "./models.ts";

describe("Claude model metadata", () => {
  it("resolves the Fable alias to the latest concrete model id", () => {
    expect(resolveModelAlias("fable")).toBe("claude-fable-5-1");
    expect(resolveModelAlias("claude-fable-5")).toBe("claude-fable-5");
  });

  it("marks both Fable versions as adaptive-thinking capable", () => {
    expect(supportsAdaptiveThinking("claude-fable-5-1")).toBe(true);
    expect(supportsAdaptiveThinking("fable")).toBe(true);
    expect(supportsAdaptiveThinking("claude-fable-5")).toBe(true);
  });

  it("resolves the Opus 5 alias to the concrete SDK model id", () => {
    expect(resolveModelAlias("opus-5")).toBe("claude-opus-5");
  });

  it("marks Opus 5 as adaptive-thinking capable", () => {
    expect(supportsAdaptiveThinking("opus-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-5")).toBe(true);
  });

  it("resolves the sonnet alias to the Sonnet 5 concrete model id", () => {
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-5");
  });

  it("marks Sonnet 5 as adaptive-thinking capable", () => {
    expect(supportsAdaptiveThinking("sonnet")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
  });

  it.each([
    ["leader", CLAUDE_MODEL_POLICY.leader],
    ...Object.entries(CLAUDE_MODEL_POLICY.minion),
  ])("prefers Fable 5.1 before Fable 5 for %s", (_role, models) => {
    expect(models).toContain("claude-fable-5-1");
    expect(models.indexOf("claude-fable-5-1")).toBeLessThan(models.indexOf("claude-fable-5"));
  });
});
