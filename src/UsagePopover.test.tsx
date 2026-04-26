/**
 * Component tests for `UsageSection`.
 *
 * The section is a thin presentational layer over `aggregateGlobalUsage`, so
 * we test the rendering surface: empty state copy, total cost, per-model rows,
 * and that bar widths reflect cost share. Aggregation correctness is covered
 * by `usage-aggregator.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageSection } from "./UsagePopover.tsx";
import {
  emptySessionUsage,
  type SessionUsage,
} from "./usage-aggregator.ts";
import type { ModelUsage } from "./use-socket.ts";

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

describe("UsageSection", () => {
  it("shows the empty-state copy when no sessions have usage", () => {
    render(<UsageSection sessions={new Map()} />);
    expect(screen.getByText(/No usage recorded yet/i)).toBeDefined();
    expect(screen.getByText("$0.0000")).toBeDefined();
  });

  it("ignores sessions with no cost or modelUsage in the empty check", () => {
    const sessions = new Map<string, SessionUsage>([
      ["unused", emptySessionUsage()],
    ]);
    render(<UsageSection sessions={sessions} />);
    expect(screen.getByText(/No usage recorded yet/i)).toBeDefined();
    expect(screen.getByText("0 sessions")).toBeDefined();
  });

  it("renders one row per model with cost and tokens", () => {
    const sessions = new Map<string, SessionUsage>([
      [
        "leader",
        {
          totalCost: 1.7,
          turns: 4,
          modelUsage: {
            "claude-opus-4-1-20250805": makeUsage({
              inputTokens: 1500,
              outputTokens: 750,
              cacheReadInputTokens: 12_000,
              costUSD: 1.5,
            }),
            "claude-sonnet-4-20250514": makeUsage({
              inputTokens: 800,
              outputTokens: 200,
              costUSD: 0.2,
            }),
          },
        },
      ],
    ]);
    render(<UsageSection sessions={sessions} />);

    expect(screen.getByText("$1.7000")).toBeDefined();
    expect(screen.getByText("1 session")).toBeDefined();
    expect(screen.getByTestId("usage-row-opus-4-1")).toBeDefined();
    expect(screen.getByTestId("usage-row-sonnet-4")).toBeDefined();

    const opusBar = screen.getByTestId("usage-bar-opus-4-1");
    const sonnetBar = screen.getByTestId("usage-bar-sonnet-4");
    expect(opusBar.style.width).toBe(
      `${Math.max((1.5 / 1.7) * 100, 2).toString()}%`,
    );
    expect(sonnetBar.style.width).toBe(
      `${Math.max((0.2 / 1.7) * 100, 2).toString()}%`,
    );
  });

  it("sums turns across sessions in the header", () => {
    const sessions = new Map<string, SessionUsage>([
      [
        "a",
        {
          totalCost: 0.1,
          turns: 3,
          modelUsage: { sonnet: makeUsage({ costUSD: 0.1 }) },
        },
      ],
      [
        "b",
        {
          totalCost: 0.2,
          turns: 5,
          modelUsage: { sonnet: makeUsage({ costUSD: 0.2 }) },
        },
      ],
    ]);
    render(<UsageSection sessions={sessions} />);
    expect(screen.getByText("8")).toBeDefined();
    expect(screen.getByText("2 sessions")).toBeDefined();
  });

  it("renders the usage section element", () => {
    render(<UsageSection sessions={new Map()} />);
    expect(screen.getByTestId("usage-section")).toBeDefined();
  });
});
