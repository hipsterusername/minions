/**
 * Render DSL — shared primitives.
 *
 * Color vocabulary and span override schemas live here, separate from
 * `shared/render-dsl.ts`, so per-family schema files (render-form.ts,
 * render-chart.ts, render-containers.ts, render-artifacts.ts) can import
 * them without creating a circular value-import cycle when render-dsl.ts
 * adds those families to its discriminated union.
 *
 * `render-dsl.ts` re-exports these primitives so existing imports stay
 * stable.
 */

import { z } from "zod/v4";

// ── Color vocabulary ───────────────────────────────────

export const componentColorSchema = z.enum([
  "green",
  "red",
  "yellow",
  "blue",
  "gray",
  "purple",
  "orange",
]);

export type ComponentColor = z.infer<typeof componentColorSchema>;

// ── Span override ──────────────────────────────────────

export const spanSchema = z.union([
  z.literal("auto"),
  z.literal("full"),
  z.number().int().min(1),
]);

export type ComponentSpan = z.infer<typeof spanSchema>;
