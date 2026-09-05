/**
 * ChartComponent — full SVG chart renderer for the render DSL.
 *
 * Supports line, bar, scatter, and area variants with labeled axes,
 * multi-series, and horizontal reference lines. Pure SVG — no external
 * chart library. Intended to be registered by the leader into the
 * RenderComponentView dispatcher.
 *
 * DO NOT import from RenderNode.tsx — this file is self-contained so the
 * leader can wire it up without circular dependencies.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { ChartComponent, ChartSeries } from "../../../shared/render-chart.ts";

// ── Color palette (matches DSL_COLORS in RenderNode.tsx) ──────────────────

type DslColorKey = "green" | "red" | "yellow" | "blue" | "gray" | "purple" | "orange";
const DSL_COLORS: { [K in DslColorKey]: string } = {
  green: "var(--status-success)",
  red: "var(--status-error)",
  yellow: "var(--status-warning)",
  blue: "var(--info-color)",
  gray: "var(--text-muted)",
  purple: "var(--thinking-accent)",
  orange: "var(--accent)",
};

const COLOR_FALLBACK = "var(--info-color)";
const COLOR_ROTATION = [
  DSL_COLORS.blue,
  DSL_COLORS.green,
  DSL_COLORS.orange,
  DSL_COLORS.purple,
  DSL_COLORS.red,
  DSL_COLORS.yellow,
] as const;

function seriesColor(s: ChartSeries, idx: number): string {
  if (s.color) return DSL_COLORS[s.color];
  return COLOR_ROTATION[idx % COLOR_ROTATION.length] ?? COLOR_FALLBACK;
}

// ── Number formatting ──────────────────────────────────────────────────────

function fmtNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (!Number.isInteger(v) && abs > 0) return v.toFixed(1);
  return String(v);
}

// ── Scale interfaces ───────────────────────────────────────────────────────

interface XScale {
  toPixel: (x: number | string) => number;
  ticks: ReadonlyArray<{ readonly label: string; readonly pixel: number }>;
  /** Slot width for category axis; undefined for linear/time axes. */
  bandWidth: number | undefined;
}

interface YScale {
  toPixel: (y: number) => number;
  ticks: ReadonlyArray<{ readonly label: string; readonly pixel: number }>;
}

// ── Scale builders ─────────────────────────────────────────────────────────

function buildCategoryXScale(series: readonly ChartSeries[], chartW: number, tickCount: number): XScale {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const s of series) {
    for (const p of s.data) {
      const key = String(p.x);
      if (!seen.has(key)) { seen.add(key); unique.push(key); }
    }
  }
  const count = Math.max(unique.length, 1);
  const band = chartW / count;
  const toPixel = (x: number | string): number => {
    const idx = unique.indexOf(String(x));
    return idx >= 0 ? (idx + 0.5) * band : 0;
  };
  const step = Math.max(1, Math.ceil(unique.length / tickCount));
  const ticks = unique
    .filter((_, i) => i % step === 0)
    .map((v) => ({ label: v, pixel: toPixel(v) }));
  return { toPixel, ticks, bandWidth: band };
}

function buildLinearXScale(series: readonly ChartSeries[], chartW: number, tickCount: number): XScale {
  let min = Infinity, max = -Infinity;
  for (const s of series) {
    for (const p of s.data) {
      const n = Number(p.x);
      if (isFinite(n)) { if (n < min) min = n; if (n > max) max = n; }
    }
  }
  if (!isFinite(min)) { min = 0; max = 1; }
  const range = max === min ? 1 : max - min;
  const toPixel = (x: number | string): number => ((Number(x) - min) / range) * chartW;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const v = min + (i / Math.max(1, tickCount - 1)) * range;
    return { label: fmtNum(v), pixel: toPixel(v) };
  });
  return { toPixel, ticks, bandWidth: undefined };
}

function buildXScale(series: readonly ChartSeries[], axisType: string, chartW: number, tickCount: number): XScale {
  return axisType === "category"
    ? buildCategoryXScale(series, chartW, tickCount)
    : buildLinearXScale(series, chartW, tickCount);
}

function buildYScale(
  series: readonly ChartSeries[],
  yMin: number | undefined,
  yMax: number | undefined,
  chartH: number,
): YScale {
  let dataMin = Infinity, dataMax = -Infinity;
  for (const s of series) {
    for (const p of s.data) {
      if (p.y < dataMin) dataMin = p.y;
      if (p.y > dataMax) dataMax = p.y;
    }
  }
  if (!isFinite(dataMin)) { dataMin = 0; dataMax = 1; }
  const pad = (dataMax - dataMin) * 0.05 || 0.5;
  const min = yMin ?? dataMin - pad;
  const max = yMax ?? dataMax + pad;
  const range = max === min ? 1 : max - min;
  const toPixel = (y: number): number => chartH - ((y - min) / range) * chartH;
  const ticks = Array.from({ length: 4 }, (_, i) => {
    const v = min + (i / 3) * range;
    return { label: fmtNum(v), pixel: toPixel(v) };
  });
  return { toPixel, ticks };
}

// ── Series renderers ───────────────────────────────────────────────────────

function renderLineSeries(data: ChartSeries["data"], color: string, xScale: XScale, yScale: YScale) {
  if (data.length === 0) return null;
  const parts: string[] = [];
  let first = true;
  for (const p of data) {
    const px = xScale.toPixel(p.x), py = yScale.toPixel(p.y);
    parts.push(first ? `M${px},${py}` : `L${px},${py}`);
    first = false;
  }
  return (
    <path d={parts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  );
}

function renderAreaSeries(
  data: ChartSeries["data"],
  color: string,
  xScale: XScale,
  yScale: YScale,
  chartH: number,
) {
  if (data.length === 0) return null;
  const lineParts: string[] = [];
  let first = true, firstX = 0, lastX = 0;
  for (const p of data) {
    const px = xScale.toPixel(p.x), py = yScale.toPixel(p.y);
    lineParts.push(first ? `M${px},${py}` : `L${px},${py}`);
    if (first) firstX = px;
    lastX = px;
    first = false;
  }
  const linePath = lineParts.join(" ");
  const areaPath = `${linePath} L${lastX},${chartH} L${firstX},${chartH} Z`;
  return (
    <g>
      <path d={areaPath} fill={color} opacity={0.15} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function renderBarSeries(
  data: ChartSeries["data"],
  seriesIdx: number,
  seriesCount: number,
  color: string,
  xScale: XScale,
  yScale: YScale,
  chartH: number,
) {
  const bandWidth = xScale.bandWidth ?? 30;
  const totalBarW = bandWidth * 0.8;
  const barW = Math.max(2, totalBarW / Math.max(seriesCount, 1));
  const startOff = -totalBarW / 2;
  return (
    <g>
      {data.map((p, i) => {
        const barLeft = xScale.toPixel(p.x) + startOff + seriesIdx * barW;
        const barTop = yScale.toPixel(p.y);
        return (
          <rect key={i} x={barLeft} y={barTop} width={barW} height={Math.max(0, chartH - barTop)} fill={color} opacity={0.75} rx={1} />
        );
      })}
    </g>
  );
}

function renderScatterSeries(data: ChartSeries["data"], color: string, xScale: XScale, yScale: YScale) {
  return (
    <g>
      {data.map((p, i) => (
        <circle key={i} cx={xScale.toPixel(p.x)} cy={yScale.toPixel(p.y)} r={3} fill={color} opacity={0.75} />
      ))}
    </g>
  );
}

// ── Series group ───────────────────────────────────────────────────────────

function ChartSeriesGroup({
  series,
  variant,
  xScale,
  yScale,
  chartH,
}: {
  series: readonly ChartSeries[];
  variant: string;
  xScale: XScale;
  yScale: YScale;
  chartH: number;
}) {
  return (
    <>
      {series.map((s, i) => {
        const color = seriesColor(s, i);
        if (variant === "bar") return <g key={i}>{renderBarSeries(s.data, i, series.length, color, xScale, yScale, chartH)}</g>;
        if (variant === "scatter") return <g key={i}>{renderScatterSeries(s.data, color, xScale, yScale)}</g>;
        if (variant === "area") return <g key={i}>{renderAreaSeries(s.data, color, xScale, yScale, chartH)}</g>;
        return <g key={i}>{renderLineSeries(s.data, color, xScale, yScale)}</g>;
      })}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function ChartComponent({ component: c }: { component: ChartComponent }) {
  const height = c.height ?? 200;
  const chartId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(400);
  useEffect(() => {
    if (!plotRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setViewW(Math.max(200, entry.contentRect.width));
    });
    observer.observe(plotRef.current);
    return () => observer.disconnect();
  }, []);
  const ML = 58, MR = 40, MT = 12, MB = 48;
  const chartW = viewW - ML - MR;
  const chartH = height - MT - MB;
  const variant = c.variant ?? "line";
  const axisType = c.xAxis?.type ?? "linear";
  const xScale = buildXScale(c.series, axisType, chartW, Math.max(2, Math.floor(chartW / 90)));
  const yScale = buildYScale(c.series, c.yAxis?.min, c.yAxis?.max, chartH);
  const hasData = c.series.some((s) => s.data.length > 0);

  return (
    <div
      className="rd-card rd-fade-in"
      style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}
    >
      {c.title && (
        <div style={{ fontSize: "var(--rd-body-size, 14px)", fontWeight: 600, color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}>
          {c.title}
        </div>
      )}

      {/* Legend — always shown so series labels are visible even on empty data */}
      {c.series.length > 0 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {c.series.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--rd-label-size, 12px)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
              <span style={{ display: "inline-block", width: 14, height: 2, background: seriesColor(s, i), borderRadius: 1, flexShrink: 0 }} />
              {s.label}
            </div>
          ))}
        </div>
      )}

      <div ref={plotRef} style={{ minWidth: 0 }}>
      {/* Chart area or empty state */}
      {!hasData ? (
        <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "var(--rd-body-size, 14px)" }}>
          No data to display
        </div>
      ) : (
        <svg role="img" aria-labelledby={`${chartId}-title`} aria-describedby={`${chartId}-description`} viewBox={`0 0 ${viewW} ${height}`} width="100%" height={height} style={{ display: "block", overflow: "visible" }}>
          <title id={`${chartId}-title`}>{c.title ?? "Chart"}</title>
          <desc id={`${chartId}-description`}>{`${variant} chart with ${c.series.length} series. Exact values are available in View chart data below.`}</desc>
          <g transform={`translate(${ML},${MT})`}>
            {yScale.ticks.map((tick, i) => (
              <g key={i}>
                <line x1={0} y1={tick.pixel} x2={chartW} y2={tick.pixel} stroke="var(--border-default)" strokeWidth="0.5" opacity={0.7} />
                <text x={-6} y={tick.pixel} textAnchor="end" dominantBaseline="middle" fontSize={12} fill="var(--text-muted)">{tick.label.length > 12 ? `${tick.label.slice(0, 11)}…` : tick.label}</text>
              </g>
            ))}
            <line x1={0} y1={0} x2={0} y2={chartH} stroke="var(--border-hover)" strokeWidth="1" />
            <line x1={0} y1={chartH} x2={chartW} y2={chartH} stroke="var(--border-hover)" strokeWidth="1" />
            {xScale.ticks.map((tick, i) => (
              <g key={i}>
                <line x1={tick.pixel} y1={chartH} x2={tick.pixel} y2={chartH + 4} stroke="var(--border-hover)" strokeWidth="1" />
                <text x={tick.pixel} y={chartH + 18} textAnchor="middle" fontSize={12} fill="var(--text-muted)">{tick.label.length > 12 ? `${tick.label.slice(0, 11)}…` : tick.label}</text>
              </g>
            ))}
            {c.xAxis?.label && (
              <text x={chartW / 2} y={chartH + 40} textAnchor="middle" fontSize={12} fill="var(--text-muted)">{c.xAxis.label}</text>
            )}
            {c.yAxis?.label && (
              <text x={-chartH / 2} y={-46} transform="rotate(-90)" textAnchor="middle" fontSize={12} fill="var(--text-muted)">{c.yAxis.label}</text>
            )}
            {c.referenceLines?.map((ref, i) => {
              const py = yScale.toPixel(ref.value);
              return (
                <g key={i}>
                  <line x1={0} y1={py} x2={chartW} y2={py} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4,3" opacity={0.6} />
                  {ref.label && (
                    <text x={chartW + 4} y={py} dominantBaseline="middle" fontSize={12} fill="var(--text-muted)">{ref.label}</text>
                  )}
                </g>
              );
            })}
            <ChartSeriesGroup series={c.series} variant={variant} xScale={xScale} yScale={yScale} chartH={chartH} />
          </g>
        </svg>
      )}
      </div>
      {hasData && (
        <details className="dashboard-chart-data">
          <summary>View chart data</summary>
          <div className="dashboard-chart-data-scroll" tabIndex={0} role="region" aria-label={`${c.title ?? "Chart"} data`}>
            <table>
              <caption>{c.title ?? "Chart"} — exact values</caption>
              <thead><tr><th scope="col">Series</th><th scope="col">{c.xAxis?.label ?? "X"}</th><th scope="col">{c.yAxis?.label ?? "Value"}</th></tr></thead>
              <tbody>{c.series.flatMap((series, index) => series.data.map((point, pointIndex) => (
                <tr key={`${index}-${pointIndex}`}><th scope="row">{series.label}</th><td>{point.x}</td><td>{point.y}</td></tr>
              )))}</tbody>
            </table>
            {c.referenceLines?.map((line, index) => <p key={index}>{line.label ?? "Reference"}: {line.value}</p>)}
          </div>
        </details>
      )}
    </div>
  );
}
