import { describe, it, expect } from "vitest";
import {
  aggregateGlobalUsage,
  emptySessionUsage,
  formatTokens,
  formatSessionUsageLine,
  mergeDoneEvent,
  mergeUsageEvent,
  type SessionUsage,
} from "./usage-aggregator.ts";

describe("mergeUsageEvent", () => {
  it("sets totalCost from costUSD", () => {
    const next = mergeUsageEvent(emptySessionUsage(), {
      input: 10,
      output: 2,
      costUSD: 0.42,
    });
    expect(next.totalCost).toBe(0.42);
    expect(next.turns).toBe(0); // untouched
    expect(next.input).toBe(10);
    expect(next.output).toBe(2);
  });

  it("replaces totalCost rather than summing (SDK reports cumulative)", () => {
    const seeded = mergeUsageEvent(emptySessionUsage(), {
      input: 1,
      output: 1,
      costUSD: 0.1,
    });
    const next = mergeUsageEvent(seeded, {
      input: 1,
      output: 1,
      costUSD: 0.3,
    });
    expect(next.totalCost).toBe(0.3);
    expect(next.input).toBe(2);
  });

  it("keeps result-level cumulative tokens out of token totals while surfacing cost", () => {
    const seeded = mergeUsageEvent(emptySessionUsage(), {
      source: "assistant",
      input: 10,
      output: 2,
    });
    const next = mergeUsageEvent(seeded, {
      source: "result",
      input: 1000,
      output: 500,
      cacheRead: 900,
      costUSD: 0.47,
    });

    expect(next).toMatchObject({
      totalCost: 0.47,
      input: 10,
      output: 2,
      cacheRead: 0,
    });
  });

  it("counts Codex turn_completed rows as final token usage", () => {
    const next = mergeUsageEvent(emptySessionUsage(), {
      source: "turn_completed",
      input: 100,
      output: 10,
      cacheRead: 50,
    });

    expect(next).toMatchObject({ input: 100, output: 10, cacheRead: 50 });
  });

  it("computes cache hit rate from input plus cache-read tokens", () => {
    const next = mergeUsageEvent(emptySessionUsage(), {
      input: 100,
      output: 10,
      cacheRead: 900,
      cacheCreation: 25,
    });

    expect(next.cacheHitRate).toBe(0.9);
    expect(formatSessionUsageLine(next)).toBe("in 100 / out 10 / cache 90%");
  });
});

describe("mergeDoneEvent", () => {
  it("sets turns from the done event", () => {
    const next = mergeDoneEvent(emptySessionUsage(), 3);
    expect(next.turns).toBe(3);
    expect(next.totalCost).toBe(0); // untouched
  });

  it("replaces previous turns on subsequent done events", () => {
    const first = mergeDoneEvent(emptySessionUsage(), 1);
    const second = mergeDoneEvent(first, 5);
    expect(second.turns).toBe(5);
  });
});

describe("aggregateGlobalUsage", () => {
  it("returns zeroed totals when there are no sessions", () => {
    const agg = aggregateGlobalUsage(new Map());
    expect(agg.totalCost).toBe(0);
    expect(agg.totalTurns).toBe(0);
    expect(agg.input).toBe(0);
    expect(agg.output).toBe(0);
    expect(agg.cacheHitRate).toBe(0);
    expect(agg.sessionCount).toBe(0);
  });

  it("ignores sessions that have no usage and no cost yet", () => {
    const sessions = new Map<string, SessionUsage>([
      ["empty", emptySessionUsage()],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.sessionCount).toBe(0);
  });

  it("counts a session once it has cost", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", mergeUsageEvent(emptySessionUsage(), 0.5)],
    ]);
    expect(aggregateGlobalUsage(sessions).sessionCount).toBe(1);
  });

  it("counts a session once it has token usage", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", mergeUsageEvent(emptySessionUsage(), { input: 5, output: 1 })],
    ]);
    expect(aggregateGlobalUsage(sessions).sessionCount).toBe(1);
  });

  it("counts a session once it has turns even with no cost", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", mergeDoneEvent(emptySessionUsage(), 1)],
    ]);
    expect(aggregateGlobalUsage(sessions).sessionCount).toBe(1);
  });

  it("sums cost and turns across sessions", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", mergeDoneEvent(mergeUsageEvent(emptySessionUsage(), 0.5), 1)],
      ["b", mergeDoneEvent(mergeUsageEvent(emptySessionUsage(), 1.0), 2)],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.totalCost).toBeCloseTo(1.5, 6);
    expect(agg.totalTurns).toBe(3);
    expect(agg.sessionCount).toBe(2);
  });

  it("sums token totals and cache hit rate across sessions", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", mergeUsageEvent(emptySessionUsage(), { input: 100, output: 10, cacheRead: 300 })],
      ["b", mergeUsageEvent(emptySessionUsage(), { input: 100, output: 20, cacheRead: 500 })],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.input).toBe(200);
    expect(agg.output).toBe(30);
    expect(agg.cacheRead).toBe(800);
    expect(agg.cacheHitRate).toBe(0.8);
  });
});

describe("formatTokens", () => {
  it("formats tokens at three scales", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(945)).toBe("945");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});
