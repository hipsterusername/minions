/**
 * Component tests for ChartComponent.
 *
 * Asserts:
 *   - Title and series labels render in the DOM
 *   - Each variant produces the expected SVG shape elements
 *   - Reference lines render with their labels
 *   - Empty data series produces a graceful empty state without crashing
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartComponent } from "./ChartComponent.tsx";
import type { ChartComponent as ChartComponentType } from "../../../shared/render-chart.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const lineComponent: ChartComponentType = {
  id: "chart-line",
  type: "chart",
  title: "Test Chart",
  variant: "line",
  series: [
    {
      label: "Series A",
      data: [
        { x: 1, y: 10 },
        { x: 2, y: 20 },
        { x: 3, y: 15 },
      ],
    },
  ],
};

const multiSeriesComponent: ChartComponentType = {
  id: "chart-multi",
  type: "chart",
  title: "Multi Series",
  series: [
    { label: "Alpha", data: [{ x: 1, y: 5 }, { x: 2, y: 10 }] },
    { label: "Beta", data: [{ x: 1, y: 3 }, { x: 2, y: 7 }], color: "green" },
  ],
};

// ── Title and legend ───────────────────────────────────────────────────────

describe("ChartComponent: title and legend", () => {
  it("renders the chart title", () => {
    render(<ChartComponent component={lineComponent} />);
    expect(screen.getByText("Test Chart")).toBeInTheDocument();
  });

  it("renders the series label in the legend", () => {
    render(<ChartComponent component={lineComponent} />);
    expect(screen.getByText("Series A")).toBeInTheDocument();
  });

  it("renders all series labels for a multi-series chart", () => {
    render(<ChartComponent component={multiSeriesComponent} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("renders without title when none is provided", () => {
    const c: ChartComponentType = { ...lineComponent, title: undefined, id: "no-title" };
    // Just assert it renders without crashing
    const { container } = render(<ChartComponent component={c} />);
    expect(container.firstChild).not.toBeNull();
  });
});

// ── SVG shape assertions per variant ──────────────────────────────────────

describe("ChartComponent: line variant", () => {
  it("renders a <path> element for the line series", () => {
    const { container } = render(<ChartComponent component={lineComponent} />);
    expect(container.querySelector("path")).not.toBeNull();
  });

  it("does not render <rect> elements for a line chart", () => {
    const { container } = render(<ChartComponent component={lineComponent} />);
    expect(container.querySelector("rect")).toBeNull();
  });
});

describe("ChartComponent: bar variant", () => {
  const barComponent: ChartComponentType = {
    id: "chart-bar",
    type: "chart",
    title: "Bar Chart",
    variant: "bar",
    xAxis: { type: "category" },
    series: [
      {
        label: "Requests",
        data: [
          { x: "Mon", y: 12 },
          { x: "Tue", y: 19 },
          { x: "Wed", y: 7 },
        ],
      },
    ],
  };

  it("renders <rect> elements for bar series", () => {
    const { container } = render(<ChartComponent component={barComponent} />);
    expect(container.querySelector("rect")).not.toBeNull();
  });

  it("renders one rect per data point", () => {
    const { container } = render(<ChartComponent component={barComponent} />);
    // 3 data points → 3 rects
    expect(container.querySelectorAll("rect").length).toBe(3);
  });
});

describe("ChartComponent: scatter variant", () => {
  const scatterComponent: ChartComponentType = {
    id: "chart-scatter",
    type: "chart",
    variant: "scatter",
    series: [
      {
        label: "Points",
        data: [
          { x: 1, y: 5 },
          { x: 3, y: 8 },
          { x: 5, y: 2 },
        ],
      },
    ],
  };

  it("renders <circle> elements for scatter series", () => {
    const { container } = render(<ChartComponent component={scatterComponent} />);
    expect(container.querySelector("circle")).not.toBeNull();
  });

  it("renders one circle per data point", () => {
    const { container } = render(<ChartComponent component={scatterComponent} />);
    expect(container.querySelectorAll("circle").length).toBe(3);
  });
});

describe("ChartComponent: area variant", () => {
  const areaComponent: ChartComponentType = {
    id: "chart-area",
    type: "chart",
    variant: "area",
    series: [
      {
        label: "Coverage",
        data: [
          { x: 0, y: 10 },
          { x: 1, y: 20 },
          { x: 2, y: 15 },
        ],
      },
    ],
  };

  it("renders <path> elements (line + filled area)", () => {
    const { container } = render(<ChartComponent component={areaComponent} />);
    const paths = container.querySelectorAll("path");
    // Area variant renders 2 paths: filled polygon + line stroke
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });

  it("includes a path with a fill (not 'none')", () => {
    const { container } = render(<ChartComponent component={areaComponent} />);
    const filled = Array.from(container.querySelectorAll("path")).filter(
      (p) => p.getAttribute("fill") !== "none",
    );
    expect(filled.length).toBeGreaterThan(0);
  });
});

// ── Reference lines ────────────────────────────────────────────────────────

describe("ChartComponent: reference lines", () => {
  const withRefLines: ChartComponentType = {
    id: "chart-ref",
    type: "chart",
    series: [{ label: "data", data: [{ x: 1, y: 10 }, { x: 2, y: 30 }] }],
    referenceLines: [
      { value: 20, label: "target" },
      { value: 25, label: "max" },
    ],
  };

  it("renders reference line labels in the SVG", () => {
    render(<ChartComponent component={withRefLines} />);
    expect(screen.getByText("target")).toBeInTheDocument();
    expect(screen.getByText("max")).toBeInTheDocument();
  });

  it("renders a dashed line for each reference line", () => {
    const { container } = render(<ChartComponent component={withRefLines} />);
    const dashedLines = Array.from(container.querySelectorAll("line")).filter((l) =>
      l.getAttribute("stroke-dasharray") != null,
    );
    expect(dashedLines.length).toBe(2);
  });
});

// ── Empty data ─────────────────────────────────────────────────────────────

describe("ChartComponent: empty data", () => {
  const emptyComponent: ChartComponentType = {
    id: "chart-empty",
    type: "chart",
    title: "Empty Chart",
    series: [{ label: "No Points", data: [] }],
  };

  it("renders the series label in the legend even with no data", () => {
    render(<ChartComponent component={emptyComponent} />);
    expect(screen.getByText("No Points")).toBeInTheDocument();
  });

  it("shows the empty state message", () => {
    render(<ChartComponent component={emptyComponent} />);
    expect(screen.getByText("No data to display")).toBeInTheDocument();
  });

  it("does not render an SVG when there is no data", () => {
    const { container } = render(<ChartComponent component={emptyComponent} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders without crashing for a zero-series chart", () => {
    const c: ChartComponentType = { id: "chart-zero", type: "chart", series: [] };
    const { container } = render(<ChartComponent component={c} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText("No data to display")).toBeInTheDocument();
  });
});

// ── Axis labels ────────────────────────────────────────────────────────────

describe("ChartComponent: axis labels", () => {
  it("renders x-axis label when provided", () => {
    const c: ChartComponentType = {
      ...lineComponent,
      id: "chart-xlbl",
      xAxis: { label: "Hour" },
    };
    render(<ChartComponent component={c} />);
    expect(screen.getByText("Hour")).toBeInTheDocument();
  });

  it("renders y-axis label when provided", () => {
    const c: ChartComponentType = {
      ...lineComponent,
      id: "chart-ylbl",
      yAxis: { label: "ms" },
    };
    render(<ChartComponent component={c} />);
    expect(screen.getByText("ms")).toBeInTheDocument();
  });
});
