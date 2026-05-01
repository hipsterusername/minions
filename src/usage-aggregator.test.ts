/**
 * Unit tests for `usage-aggregator`.
 *
 * Phase 3: cost arrives via `usage` events (mergeUsageEvent) and turns
 * via `done` events (mergeDoneEvent). The per-model breakdown is gone —
 * aggregateGlobalUsage now returns { totalCost, totalTurns, sessionCount }.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateGlobalUsage,
  emptySessionUsage,
  formatTokens,
  mergeDoneEvent,
  mergeUsageEvent,
  type SessionUsage,
} from "./usage-aggregator.ts";

describe("mergeUsageEvent", () => {
  it("sets totalCost from costUSD", () => {
    const next = mergeUsageEvent(emptySessionUsage(), 0.42);
    expect(next.totalCost).toBe(0.42);
    expect(next.turns).toBe(0); // untouched
  });

  it("replaces totalCost rather than summing (SDK reports cumulative)", () => {
    const seeded = mergeUsageEvent(emptySessionUsage(), 0.1);
    const next = mergeUsageEvent(seeded, 0.3);
    expect(next.totalCost).toBe(0.3);
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

  it("counts a session once it has turns even with no cost", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", mergeDoneEvent(emptySessionUsage(), 1)],
    ]);
    expect(aggregateGlobalUsage(sessions).sessionCount).toBe(1);
  });

  it("sums cost and turns across sessions", () => {
    const sessions = new Map<string, SessionUsage>([
      ["a", { totalCost: 0.5, turns: 1 }],
      ["b", { totalCost: 1.0, turns: 2 }],
    ]);
    const agg = aggregateGlobalUsage(sessions);
    expect(agg.totalCost).toBeCloseTo(1.5, 6);
    expect(agg.totalTurns).toBe(3);
    expect(agg.sessionCount).toBe(2);
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
