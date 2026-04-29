/**
 * Chart render-DSL component — full SVG chart with axes.
 *
 * Supersedes sparkline for cases needing axis labels, multiple series,
 * and reference lines. Variants: line, bar, scatter, area.
 *
 * **Single source of truth.** Both server tooling and client rendering
 * import types and the schema from here.
 */

import { z } from "zod/v4";
import { spanSchema, componentColorSchema } from "./render-dsl.ts";

// ── Point and series schemas ───────────────────────────────────────────────

export const chartPointSchema = z.object({
  /** Numeric x for linear/time axes; string label for category axis. */
  x: z.union([z.number(), z.string()]),
  y: z.number(),
});

export const chartSeriesSchema = z.object({
  label: z.string(),
  data: z.array(chartPointSchema),
  color: componentColorSchema.optional(),
});

// ── Chart component schema ─────────────────────────────────────────────────

export const chartComponentSchema = z.object({
  id: z.string(),
  type: z.literal("chart"),
  title: z.string().optional(),
  /** Render variant — defaults to "line". */
  variant: z.enum(["line", "bar", "scatter", "area"]).optional(),
  series: z.array(chartSeriesSchema),
  xAxis: z
    .object({
      label: z.string().optional(),
      /** Axis scale — defaults to "linear". "time" is treated like linear in v1. */
      type: z.enum(["time", "linear", "category"]).optional(),
    })
    .optional(),
  yAxis: z
    .object({
      label: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
  referenceLines: z
    .array(
      z.object({
        value: z.number(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  /** SVG height in px — defaults to 200. */
  height: z.number().optional(),
  span: spanSchema.optional(),
});

// ── Exported types ─────────────────────────────────────────────────────────

export type ChartPoint = z.infer<typeof chartPointSchema>;
export type ChartSeries = z.infer<typeof chartSeriesSchema>;
export type ChartComponent = z.infer<typeof chartComponentSchema>;

// ── Markdown helper ────────────────────────────────────────────────────────

/**
 * Produce a compact markdown summary of a chart: title, variant, series
 * labels, and value ranges. Used when flattening dashboard state to text.
 *
 * Example output:
 *   ### Latency by hour (line)
 *   - web: [12, 14, 19, 28, 34, ...] (range 12–34)
 *   - api: (no data)
 */
export function formatChart(c: ChartComponent): string {
  const variant = c.variant ?? "line";
  const header = c.title ? `### ${c.title} (${variant})` : `### Chart (${variant})`;

  if (c.series.length === 0) return header;

  const lines = c.series.map((s) => {
    if (s.data.length === 0) return `- ${s.label}: (no data)`;
    const vals = s.data.map((p) => p.y);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const preview = vals.slice(0, 5).join(", ") + (vals.length > 5 ? ", ..." : "");
    return `- ${s.label}: [${preview}] (range ${min}–${max})`;
  });

  return [header, ...lines].join("\n");
}
