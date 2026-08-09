import { describe, expect, it } from "vitest";
import {
  DEFAULT_LARGE_CONTEXT_WINDOW_TOKENS,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  evaluateCompactionUsage,
  initialCompactionAdvisorState,
  contextWindowForModel,
} from "./compaction-advisor.ts";

describe("compaction advisor", () => {
  it("recommends once when usage crosses 55% of the model window", () => {
    const state = initialCompactionAdvisorState();

    expect(
      evaluateCompactionUsage(state, { kind: "usage", input: 109_999, output: 0 }, "sonnet").action,
    ).toBe("none");
    expect(
      evaluateCompactionUsage(state, { kind: "usage", input: 110_000, output: 0 }, "sonnet").action,
    ).toBe("recommend");
    expect(
      evaluateCompactionUsage(state, { kind: "usage", input: 120_000, output: 0 }, "sonnet").action,
    ).toBe("none");
  });

  it("forces once at 80% and includes cacheRead in context size", () => {
    const state = initialCompactionAdvisorState();

    expect(
      evaluateCompactionUsage(
        state,
        { kind: "usage", input: 100_000, cacheRead: 60_000, output: 0 },
        "sonnet",
      ).action,
    ).toBe("force");
    expect(
      evaluateCompactionUsage(
        state,
        { kind: "usage", input: 100_000, cacheRead: 80_000, output: 0 },
        "sonnet",
      ).action,
    ).toBe("none");
  });

  it("uses a large local default for opus/fable-tier models and 200k fallback", () => {
    expect(contextWindowForModel("claude-opus-4-5")).toBe(DEFAULT_LARGE_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowForModel("fable-5")).toBe(DEFAULT_LARGE_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowForModel("unknown-small")).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });
});

