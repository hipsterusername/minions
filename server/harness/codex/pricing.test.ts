import { describe, expect, it } from "vitest";
import { estimateCodexTurnCostUSD, ordinaryCodexInputTokens } from "./pricing.ts";

describe("estimateCodexTurnCostUSD", () => {
  it("prices ordinary input, cached input, cache writes, and output once", () => {
    expect(estimateCodexTurnCostUSD("gpt-5.6-sol", {
      inputTokens: 1_000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 100,
      outputTokens: 50,
    })).toBeCloseTo(0.00438, 10);
  });

  it("normalizes Codex's inclusive input total", () => {
    expect(ordinaryCodexInputTokens({
      inputTokens: 1_000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 100,
      outputTokens: 50,
    })).toBe(700);
  });

  it("uses long-context rates when the input exceeds 272K tokens", () => {
    expect(estimateCodexTurnCostUSD("gpt-5.6-sol", {
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000,
    })).toBeCloseTo(1.71, 10);
  });

  it("includes per-call web search charges", () => {
    expect(estimateCodexTurnCostUSD("gpt-5.6-luna", {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    }, 2)).toBeCloseTo(0.02, 10);
  });

  it("does not invent prices for unknown models or inconsistent usage", () => {
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 30,
      outputTokens: 10,
    };
    expect(estimateCodexTurnCostUSD("future-model", usage)).toBeNull();
    expect(estimateCodexTurnCostUSD("gpt-5.6-sol", usage)).toBeNull();
  });
});
