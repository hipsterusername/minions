/**
 * Unit tests for `usage-aggregator`.
 *
 * The aggregator is the source of truth for what the /usage popover shows,
 * so we cover:
 *   - merging a single SDK result into an empty session
 *   - merging a second result that adds a new model alongside the first
 *   - global aggregation summing tokens/cost across multiple sessions
 *   - sorting global rows by descending cost
 *   - empty input edge cases
 *   - formatting helpers
 */
import { describe, it, expect } from "vitest";
import {
  aggregateGlobalUsage,
  emptySessionUsage,
  formatTokens,
  mergeResultIntoSession,
  type SessionUsage,
} from "./usage-aggregator.ts";
import type { ModelUsage, SdkResultSuccess } from "./use-socket.ts";

function makeUsage(partial: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    ...partial,
  };
}

function makeResult(
  overrides: {
    totalCostUsd?: number;
    numTurns?: number;
    modelUsage?: Record<string, ModelUsage>;
  } = {},
): SdkResultSuccess {
  return {
    type: "result",
    subtype: "success",
    result: "ok",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: overrides.numTurns ?? 1,
    stop_reason: "end_turn",
    total_cost_usd: overrides.totalCostUsd ?? 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: overrides.modelUsage ?? {},
    permission_denials: [],
    uuid: "u",
    session_id: "s",
  };
}

describe("mergeResultIntoSession", () => {
  it("seeds usage from the first result", () => {
    const result = makeResult({
      totalCostUsd: 0.42,
      numTurns: 3,
      modelUsage: {
        "claude-sonnet-4-20250514": makeUsage({
          inputTokens: 1000,
          outputTokens: 500,
          costUSD: 0.42,
        }),
      },
    });
    const next = mergeResultIntoSession(emptySessionUsage(), result);
    expect(next.totalCost).toBe(0.42);
    expect(next.turns).toBe(3);
    expect(next.modelUsage["claude-sonnet-4-20250514"]?.inputTokens).toBe(1000);
    expect(next.modelUsage["claude-sonnet-4-20250514"]?.outputTokens).toBe(500);
  });

  // Removed: "does not mutate the input session" — implementation detail.
  // See docs/testing-strategy.md §5.

  it("replaces totalCost rather than summing (SDK reports cumulative)", () => {
    const seeded = mergeResultIntoSession(
      emptySessionUsage(),
      makeResult({ totalCostUsd: 0.1 }),
    );
    const next = mergeResultIntoSession(seeded, makeResult({ totalCostUsd: 0.3 }));
    expect(next.totalCost).toBe(0.3);
  });

  it("adds a second model alongside the first", () => {
    const seeded = mergeResultIntoSession(
      emptySessionUsage(),
      makeResult({
        modelUsage: {
          sonnet: makeUsage({ inputTokens: 100, costUSD: 0.05 }),
        },
      }),
    );
    const next = mergeResultIntoSession(
      seeded,
      makeResult({
        modelUsage: {
          opus: makeUsage({ inputTokens: 200, costUSD: 0.5 }),
        },
      }),
    );
    expect(Object.keys(next.modelUsage).sort()).toEqual(["opus", "sonnet"]);
    expect(next.modelUsage["sonnet"]?.inputTokens).toBe(100);
    expect(next.modelUsage["opus"]?.inputTokens).toBe(200);
  });

  it("uses max() to reconcile updated counts for the same model", () => {
    const seeded = mergeResultIntoSession(
      emptySessionUsage(),
      makeResult({
        modelUsage: { sonnet: makeUsage({ inputTokens: 100, costUSD: 0.1 }) },
      }),
    );
    const next = mergeResultIntoSession(
      seeded,
      makeResult({
        modelUsage: { sonnet: makeUsage({ inputTokens: 250, costUSD: 0.25 }) },
      }),
    );
    expect(next.modelUsage["sonnet"]?.inputTokens).toBe(250);
    expect(next.modelUsage["sonnet"]?.costUSD).toBe(0.25);
  });
});

describe("aggregateGlobalUsage", () => {
  it("returns zeroed totals when there are no sessions", () => {
    const agg = aggregateGlobalUsage(new Map());
    expect(agg.totalCost).toBe(0);
    expect(agg.byModel).toEqual([]);
    expect(agg.sessionCount).toBe(0);
  });

  it("ignores sessions that have no usage and no cost yet", () => {
    const sessions = new Map<string, SessionUsage>([
      ["empty", emptySessionUsage()],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.sessionCount).toBe(0);
  });

  it("sums tokens across sessions for the same model", () => {
    const sessions = new Map<string, SessionUsage>([
      [
        "a",
        {
          totalCost: 0.5,
          turns: 1,
          modelUsage: { sonnet: makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.5 }) },
        },
      ],
      [
        "b",
        {
          totalCost: 1.0,
          turns: 2,
          modelUsage: { sonnet: makeUsage({ inputTokens: 300, outputTokens: 150, costUSD: 1.0 }) },
        },
      ],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.totalCost).toBeCloseTo(1.5, 6);
    expect(agg.totalInputTokens).toBe(400);
    expect(agg.totalOutputTokens).toBe(200);
    expect(agg.sessionCount).toBe(2);
    expect(agg.byModel).toHaveLength(1);
    expect(agg.byModel[0]?.usage.costUSD).toBeCloseTo(1.5, 6);
  });

  it("sorts the breakdown by descending cost", () => {
    const sessions = new Map<string, SessionUsage>([
      [
        "leader",
        {
          totalCost: 1.7,
          turns: 1,
          modelUsage: {
            haiku: makeUsage({ costUSD: 0.05 }),
            opus: makeUsage({ costUSD: 1.5 }),
            sonnet: makeUsage({ costUSD: 0.15 }),
          },
        },
      ],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.byModel.map((r) => r.model)).toEqual(["opus", "sonnet", "haiku"]);
  });
});

// Removed: shortModelLabel regex pinning — couples to the literal
// stripping rules rather than the displayed-label contract. See
// docs/testing-strategy.md §5.

describe("formatTokens", () => {
  it("formats tokens at three scales", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(945)).toBe("945");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});
