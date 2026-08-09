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
});
