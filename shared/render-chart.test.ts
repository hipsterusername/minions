/**
 * Tests for the chart render-DSL schema and formatChart helper.
 *
 * Covers:
 *   1. Schema happy paths (minimal, full, edge-case variants)
 *   2. Schema rejection of invalid shapes
 *   3. formatChart output structure and content
 */

import { describe, expect, it } from "vitest";
import { chartComponentSchema, formatChart } from "./render-chart.ts";
import type { ChartComponent } from "./render-chart.ts";

// ── Schema tests ───────────────────────────────────────────────────────────

describe("chartComponentSchema", () => {
  it("parses a minimal valid chart (no optional fields)", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
      series: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses a chart with all optional fields populated", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
      title: "Latency",
      variant: "line",
      series: [
        {
          label: "web",
          data: [
            { x: 1, y: 10 },
            { x: 2, y: 20 },
          ],
          color: "blue",
        },
      ],
      xAxis: { label: "Hour", type: "linear" },
      yAxis: { label: "ms", min: 0, max: 100 },
      referenceLines: [{ value: 50, label: "P50" }],
      height: 300,
      span: "full",
    });
    expect(result.success).toBe(true);
  });

  it("parses all valid variant values", () => {
    for (const variant of ["line", "bar", "scatter", "area"] as const) {
      const result = chartComponentSchema.safeParse({
        id: "c1",
        type: "chart",
        series: [],
        variant,
      });
      expect(result.success, `variant "${variant}" should be valid`).toBe(true);
    }
  });

  it("accepts string x values for category axis", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
      series: [
        {
          label: "A",
          data: [
            { x: "Mon", y: 5 },
            { x: "Tue", y: 8 },
          ],
        },
      ],
      xAxis: { type: "category" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts numeric x values", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
      series: [{ label: "A", data: [{ x: 1.5, y: 42 }] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid componentColor values", () => {
    for (const color of ["green", "red", "yellow", "blue", "gray", "purple", "orange"] as const) {
      const result = chartComponentSchema.safeParse({
        id: "c1",
        type: "chart",
        series: [{ label: "A", data: [], color }],
      });
      expect(result.success, `color "${color}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid variant", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
      series: [],
      variant: "pie",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid series color", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
      series: [{ label: "A", data: [], color: "pink" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type discriminant", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "sparkline",
      series: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required series field", () => {
    const result = chartComponentSchema.safeParse({
      id: "c1",
      type: "chart",
    });
    expect(result.success).toBe(false);
  });
});

// ── formatChart tests ──────────────────────────────────────────────────────

describe("formatChart", () => {
  const base: ChartComponent = {
    id: "c1",
    type: "chart",
    title: "Latency by hour",
    variant: "line",
    series: [
      {
        label: "web",
        data: [
          { x: 1, y: 12 },
          { x: 2, y: 14 },
          { x: 3, y: 34 },
        ],
      },
    ],
  };

  it("includes title and variant in the header", () => {
    const result = formatChart(base);
    expect(result).toContain("Latency by hour");
    expect(result).toContain("line");
    expect(result.startsWith("###")).toBe(true);
  });

  it("includes the series label", () => {
    expect(formatChart(base)).toContain("web");
  });

  it("shows min and max of the series y values", () => {
    const result = formatChart(base);
    expect(result).toContain("12");
    expect(result).toContain("34");
  });

  it("includes the range annotation", () => {
    expect(formatChart(base)).toContain("range");
  });

  it("falls back to 'Chart' when no title is set", () => {
    const result = formatChart({ id: "c1", type: "chart", series: [] });
    expect(result).toContain("Chart");
  });

  it("uses 'line' when no variant is set", () => {
    const result = formatChart({ id: "c1", type: "chart", series: [] });
    expect(result).toContain("line");
  });

  it("renders 'no data' for an empty series", () => {
    const result = formatChart({
      id: "c1",
      type: "chart",
      series: [{ label: "empty", data: [] }],
    });
    expect(result).toContain("empty");
    expect(result).toContain("no data");
  });

  it("truncates long series with ellipsis", () => {
    const result = formatChart({
      id: "c1",
      type: "chart",
      series: [
        {
          label: "big",
          data: [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ x: v, y: v })),
        },
      ],
    });
    expect(result).toContain("...");
  });

  it("handles multiple series, one line each", () => {
    const result = formatChart({
      id: "c1",
      type: "chart",
      series: [
        { label: "web", data: [{ x: 1, y: 10 }] },
        { label: "api", data: [{ x: 1, y: 20 }] },
      ],
    });
    const lines = result.split("\n");
    expect(lines.length).toBe(3); // header + 2 series
    expect(lines[1]).toContain("web");
    expect(lines[2]).toContain("api");
  });

  it("returns only the header for an empty series array", () => {
    const result = formatChart({ id: "c1", type: "chart", series: [] });
    expect(result.split("\n")).toHaveLength(1);
  });
});
