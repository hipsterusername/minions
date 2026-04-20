/**
 * Render DSL — a compact component vocabulary for agent-driven dashboards.
 *
 * **Single source of truth.** Both the server (`server/render-tools.ts`) and
 * the client (`src/render-dsl.ts`, `src/nodes/RenderNode.tsx`) import from
 * this module. A new component type is added here once.
 *
 * Zod schemas live alongside the TypeScript types so the server can validate
 * MCP tool arguments and the shared contract test can exercise parity on
 * both sides. Client-side types are inferred via `z.infer<typeof schema>`.
 *
 * Design principles:
 *   1. Token-efficient — agents describe UI in minimal JSON
 *   2. Patch-friendly — every component has an `id` for targeted updates
 *   3. Constrained — fixed set of primitives, no arbitrary HTML/React
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

// ── Component primitives ───────────────────────────────

export const metricComponentSchema = z.object({
  id: z.string(),
  type: z.literal("metric"),
  label: z.string(),
  value: z.string(),
  color: componentColorSchema.optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
  detail: z.string().optional(),
});

export const progressComponentSchema = z.object({
  id: z.string(),
  type: z.literal("progress"),
  label: z.string(),
  value: z.number(),
  color: componentColorSchema.optional(),
});

export const tableComponentSchema = z.object({
  id: z.string(),
  type: z.literal("table"),
  title: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

export const listComponentSchema = z.object({
  id: z.string(),
  type: z.literal("list"),
  title: z.string().optional(),
  items: z.array(z.string()),
  ordered: z.boolean().optional(),
});

export const textComponentSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  content: z.string(),
});

export const statusComponentSchema = z.object({
  id: z.string(),
  type: z.literal("status"),
  label: z.string(),
  state: z.enum(["success", "error", "warning", "running", "pending"]),
});

export const codeComponentSchema = z.object({
  id: z.string(),
  type: z.literal("code"),
  language: z.string().optional(),
  content: z.string(),
  title: z.string().optional(),
});

/**
 * Full union of render components. `z.discriminatedUnion` both narrows
 * `type` on the TS side and lets the server reject unknown component
 * shapes instead of silently accepting them via `.passthrough()`.
 */
export const renderComponentSchema = z.discriminatedUnion("type", [
  metricComponentSchema,
  progressComponentSchema,
  tableComponentSchema,
  listComponentSchema,
  textComponentSchema,
  statusComponentSchema,
  codeComponentSchema,
]);

export type MetricComponent = z.infer<typeof metricComponentSchema>;
export type ProgressComponent = z.infer<typeof progressComponentSchema>;
export type TableComponent = z.infer<typeof tableComponentSchema>;
export type ListComponent = z.infer<typeof listComponentSchema>;
export type TextComponent = z.infer<typeof textComponentSchema>;
export type StatusComponent = z.infer<typeof statusComponentSchema>;
export type CodeComponent = z.infer<typeof codeComponentSchema>;
export type RenderComponent = z.infer<typeof renderComponentSchema>;

// ── Layout ─────────────────────────────────────────────

export const renderLayoutSchema = z.object({
  columns: z.number().optional(),
  gap: z.number().optional(),
  title: z.string().optional(),
});

export type RenderLayout = z.infer<typeof renderLayoutSchema>;

// ── Full render state ──────────────────────────────────

export interface RenderState {
  layout: RenderLayout;
  components: RenderComponent[];
}

// ── Messages (agent → render node) ─────────────────────

export const renderSetMessageSchema = z.object({
  action: z.literal("set"),
  layout: renderLayoutSchema.optional(),
  components: z.array(renderComponentSchema),
});

/**
 * Partial update. Each entry must include `id`; other fields are a subset
 * of a component. We validate the id-requirement here and let the client
 * reducer merge by `id` while preserving the existing component's `type`.
 */
export const renderPatchUpdateSchema = z
  .object({ id: z.string() })
  .passthrough();

export const renderPatchMessageSchema = z.object({
  action: z.literal("patch"),
  updates: z.array(renderPatchUpdateSchema),
});

export const renderRemoveMessageSchema = z.object({
  action: z.literal("remove"),
  ids: z.array(z.string()),
});

export const renderAppendMessageSchema = z.object({
  action: z.literal("append"),
  components: z.array(renderComponentSchema),
});

export const renderMessageSchema = z.discriminatedUnion("action", [
  renderSetMessageSchema,
  renderPatchMessageSchema,
  renderRemoveMessageSchema,
  renderAppendMessageSchema,
]);

export type RenderSetMessage = z.infer<typeof renderSetMessageSchema>;
export type RenderPatchMessage = z.infer<typeof renderPatchMessageSchema>;
export type RenderRemoveMessage = z.infer<typeof renderRemoveMessageSchema>;
export type RenderAppendMessage = z.infer<typeof renderAppendMessageSchema>;
export type RenderMessage = z.infer<typeof renderMessageSchema>;

// ── Helpers ────────────────────────────────────────────

/** Apply a RenderMessage to existing state, returning new state. */
export function applyRenderMessage(
  state: RenderState,
  msg: RenderMessage,
): RenderState {
  switch (msg.action) {
    case "set":
      return {
        layout: msg.layout ?? state.layout,
        components: msg.components,
      };

    case "patch": {
      const updates = new Map(msg.updates.map((u) => [u.id, u]));
      return {
        ...state,
        components: state.components.map((c) => {
          const patch = updates.get(c.id);
          if (!patch) return c;
          // Merge patch into component, preserving type + id
          return { ...c, ...patch, id: c.id, type: c.type } as RenderComponent;
        }),
      };
    }

    case "remove": {
      const removeSet = new Set(msg.ids);
      return {
        ...state,
        components: state.components.filter((c) => !removeSet.has(c.id)),
      };
    }

    case "append": {
      // Deduplicate: if an appended component's id already exists, replace it
      const existingIds = new Set(msg.components.map((c) => c.id));
      const filtered = state.components.filter((c) => !existingIds.has(c.id));
      return {
        ...state,
        components: [...filtered, ...msg.components],
      };
    }
  }
}

/** Create an empty render state. */
export function emptyRenderState(): RenderState {
  return { layout: { columns: 2, gap: 12 }, components: [] };
}
