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
import {
  componentColorSchema,
  spanSchema,
  type ComponentColor,
  type ComponentSpan,
} from "./render-base.ts";
import {
  formComponentSchema,
  type FormComponent,
} from "./render-form.ts";
import {
  chartComponentSchema,
  type ChartComponent,
} from "./render-chart.ts";
import {
  sectionComponentSchema,
  tabsComponentSchema,
  type SectionComponent,
  type TabsComponent,
} from "./render-containers.ts";
import {
  imageComponentSchema,
  filePreviewComponentSchema,
  type ImageComponent,
  type FilePreviewComponent,
} from "./render-artifacts.ts";

// Re-export the shared primitives so existing imports (`from "./render-dsl"`)
// keep working without changes.
export { componentColorSchema, spanSchema };
export type { ComponentColor, ComponentSpan };

// Re-export new family schemas + types so existing single-import callers
// continue to find every component type via render-dsl.
export {
  formComponentSchema,
  chartComponentSchema,
  sectionComponentSchema,
  tabsComponentSchema,
  imageComponentSchema,
  filePreviewComponentSchema,
};
export type {
  FormComponent,
  ChartComponent,
  SectionComponent,
  TabsComponent,
  ImageComponent,
  FilePreviewComponent,
};

// ── Component primitives ───────────────────────────────

export const metricComponentSchema = z.object({
  id: z.string(),
  type: z.literal("metric"),
  label: z.string(),
  value: z.string(),
  color: componentColorSchema.optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
  detail: z.string().optional(),
  span: spanSchema.optional(),
});

export const progressComponentSchema = z.object({
  id: z.string(),
  type: z.literal("progress"),
  label: z.string(),
  value: z.number(),
  color: componentColorSchema.optional(),
  span: spanSchema.optional(),
});

export const tableComponentSchema = z.object({
  id: z.string(),
  type: z.literal("table"),
  title: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  span: spanSchema.optional(),
});

export const listComponentSchema = z.object({
  id: z.string(),
  type: z.literal("list"),
  title: z.string().optional(),
  items: z.array(z.string()),
  ordered: z.boolean().optional(),
  span: spanSchema.optional(),
});

export const textComponentSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  content: z.string(),
  span: spanSchema.optional(),
});

export const statusComponentSchema = z.object({
  id: z.string(),
  type: z.literal("status"),
  label: z.string(),
  state: z.enum(["success", "error", "warning", "running", "pending"]),
  span: spanSchema.optional(),
});

export const codeComponentSchema = z.object({
  id: z.string(),
  type: z.literal("code"),
  language: z.string().optional(),
  content: z.string(),
  title: z.string().optional(),
  span: spanSchema.optional(),
});

// ── New component primitives (Beautiful Evidence) ─────

/**
 * Sparkline — Tufte's "intense, simple, word-sized graphic."
 * Renders an SVG micro-chart inline with surrounding data.
 * Supports line, bar, and area variants.
 */
export const sparklineComponentSchema = z.object({
  id: z.string(),
  type: z.literal("sparkline"),
  label: z.string().optional(),
  data: z.array(z.number()),
  variant: z.enum(["line", "bar", "area"]).optional(), // default "line"
  color: componentColorSchema.optional(),
  height: z.number().optional(), // default 32
  showRange: z.boolean().optional(), // show min/max labels at endpoints
  referenceValue: z.number().optional(), // horizontal reference line
  span: spanSchema.optional(),
});

/**
 * Key-Value — dense property sheet. More structured than text,
 * lighter than a full table. Ideal for metadata, config, file info.
 */
export const kvComponentSchema = z.object({
  id: z.string(),
  type: z.literal("kv"),
  title: z.string().optional(),
  entries: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      color: componentColorSchema.optional(),
    }),
  ),
  layout: z.enum(["vertical", "horizontal"]).optional(), // default "vertical"
  span: spanSchema.optional(),
});

/**
 * Timeline — vertical event sequence with state indicators.
 * Essential for showing work history, deployment events, step progression.
 */
export const timelineComponentSchema = z.object({
  id: z.string(),
  type: z.literal("timeline"),
  title: z.string().optional(),
  events: z.array(
    z.object({
      label: z.string(),
      detail: z.string().optional(),
      state: z.enum(["success", "error", "warning", "running", "pending"]).optional(),
      time: z.string().optional(),
    }),
  ),
  span: spanSchema.optional(),
});

/**
 * Callout — semantic emphasis block with visual weight.
 * Draws attention to key findings, warnings, or highlights.
 * Inspired by GitHub-flavored markdown alerts.
 */
export const calloutComponentSchema = z.object({
  id: z.string(),
  type: z.literal("callout"),
  variant: z.enum(["info", "warning", "success", "error"]),
  title: z.string().optional(),
  content: z.string(),
  span: spanSchema.optional(),
});

/**
 * Separator — visual divider with optional section label.
 * Provides structure and breathing room without noise.
 */
export const separatorComponentSchema = z.object({
  id: z.string(),
  type: z.literal("separator"),
  label: z.string().optional(),
  span: spanSchema.optional(),
});

/**
 * Diff — before/after two-column comparison.
 * The essence of change evidence and review.
 */
export const diffComponentSchema = z.object({
  id: z.string(),
  type: z.literal("diff"),
  title: z.string().optional(),
  before: z.object({
    label: z.string().optional(),
    content: z.string(),
  }),
  after: z.object({
    label: z.string().optional(),
    content: z.string(),
  }),
  span: spanSchema.optional(),
});

/**
 * Checklist — task list with completion states.
 * Core to orchestration tracking and step verification.
 */
export const checklistComponentSchema = z.object({
  id: z.string(),
  type: z.literal("checklist"),
  title: z.string().optional(),
  items: z.array(
    z.object({
      label: z.string(),
      checked: z.boolean(),
    }),
  ),
  span: spanSchema.optional(),
});

/**
 * Copyable — a labeled block of text the user can copy to clipboard with one click.
 *
 * Use when the agent is reporting something the user is likely to copy/paste
 * elsewhere: generated commands, URLs, API keys, snippets, error messages,
 * commit hashes, file paths, env-var values, etc. Different from `code` in
 * that the affordance to copy is the primary purpose, not syntax display.
 */
export const copyableComponentSchema = z.object({
  id: z.string(),
  type: z.literal("copyable"),
  /** The text the user will copy. */
  content: z.string(),
  /** Optional short headline shown above the copyable block. */
  label: z.string().optional(),
  /** Optional explanatory caption shown beneath the label. */
  description: z.string().optional(),
  /**
   * Optional language hint. When set, the block renders monospaced and
   * shows the language as a small badge — same vocabulary as `code`.
   */
  language: z.string().optional(),
  /**
   * Render hint: "block" (multi-line, monospaced, default for content with
   * newlines) or "inline" (single-line ellipsized, default for short
   * single-line content). When omitted the renderer picks based on content.
   */
  variant: z.enum(["inline", "block"]).optional(),
  span: spanSchema.optional(),
});

/**
 * Tags — compact row of categorical badges.
 * Perfect for file types, categories, technologies, statuses.
 */
export const tagsComponentSchema = z.object({
  id: z.string(),
  type: z.literal("tags"),
  label: z.string().optional(),
  items: z.array(
    z.object({
      text: z.string(),
      color: componentColorSchema.optional(),
    }),
  ),
  span: spanSchema.optional(),
});

export const RENDER_COMPONENT_TYPES = [
  "metric",
  "progress",
  "table",
  "list",
  "text",
  "status",
  "code",
  "sparkline",
  "kv",
  "timeline",
  "callout",
  "separator",
  "diff",
  "checklist",
  "tags",
  "copyable",
  "form",
  "chart",
  "section",
  "tabs",
  "image",
  "file-preview",
] as const;

/**
 * Agent-facing component input schema.
 *
 * The canonical component schema below is intentionally strict and uses a
 * large discriminated union. Some non-Claude harness/tool-schema adapters
 * simplify that union poorly before it reaches the model. This compact schema
 * preserves the important contract in every harness: components are JSON
 * objects with stable `id` and known `type`, plus type-specific fields from
 * the Render DSL. Tool handlers still validate against `renderComponentSchema`
 * before mutating dashboard state.
 */
export const renderComponentInputSchema = z.looseObject({
  id: z.string().describe("Stable unique component id used by render_patch"),
  type: z.enum(RENDER_COMPONENT_TYPES).describe("Render DSL component type"),
}).describe(
  "Dashboard component object. Include type-specific Render DSL fields for the selected type. Never pass JSON, HTML, markdown, or JSX as a string component.",
);

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
  sparklineComponentSchema,
  kvComponentSchema,
  timelineComponentSchema,
  calloutComponentSchema,
  separatorComponentSchema,
  diffComponentSchema,
  checklistComponentSchema,
  tagsComponentSchema,
  copyableComponentSchema,
  formComponentSchema,
  chartComponentSchema,
  sectionComponentSchema,
  tabsComponentSchema,
  imageComponentSchema,
  filePreviewComponentSchema,
]);

export type MetricComponent = z.infer<typeof metricComponentSchema>;
export type ProgressComponent = z.infer<typeof progressComponentSchema>;
export type TableComponent = z.infer<typeof tableComponentSchema>;
export type ListComponent = z.infer<typeof listComponentSchema>;
export type TextComponent = z.infer<typeof textComponentSchema>;
export type StatusComponent = z.infer<typeof statusComponentSchema>;
export type CodeComponent = z.infer<typeof codeComponentSchema>;
export type SparklineComponent = z.infer<typeof sparklineComponentSchema>;
export type KvComponent = z.infer<typeof kvComponentSchema>;
export type TimelineComponent = z.infer<typeof timelineComponentSchema>;
export type CalloutComponent = z.infer<typeof calloutComponentSchema>;
export type SeparatorComponent = z.infer<typeof separatorComponentSchema>;
export type DiffComponent = z.infer<typeof diffComponentSchema>;
export type ChecklistComponent = z.infer<typeof checklistComponentSchema>;
export type TagsComponent = z.infer<typeof tagsComponentSchema>;
export type CopyableComponent = z.infer<typeof copyableComponentSchema>;

/**
 * Inferred union from zod minus the container types — those have manual
 * recursive interfaces (`SectionComponent`, `TabsComponent`) since zod's
 * `discriminatedUnion` does not compose with `z.lazy`. The exported
 * `RenderComponent` substitutes the manual interfaces back in so callers
 * see fully-typed nested children.
 */
type InferredRenderComponent = z.infer<typeof renderComponentSchema>;
type NonContainerRenderComponent = Exclude<
  InferredRenderComponent,
  { type: "section" } | { type: "tabs" }
>;
export type RenderComponent =
  | NonContainerRenderComponent
  | SectionComponent
  | TabsComponent;

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
        // Container children come back from zod as `unknown[]` because the
        // `discriminatedUnion` + `z.lazy` incompatibility forces their inner
        // schemas to stay loose. Runtime shape matches the manual
        // recursive `RenderComponent` interfaces, so the cast is sound.
        components: msg.components as RenderComponent[],
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
        components: [...filtered, ...(msg.components as RenderComponent[])],
      };
    }
  }
}

/** Create an empty render state. */
export function emptyRenderState(): RenderState {
  return { layout: { columns: 2, gap: 12 }, components: [] };
}
