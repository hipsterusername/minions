/**
 * Render DSL — canonical default values and a normaliser that strips them.
 *
 * The render DSL has many optional fields that fall back to a documented
 * default when omitted. When agents emit those fields explicitly we pay
 * the token cost on the wire AND in persisted state for no behaviour
 * change. This module is the single source of truth for "what the
 * default is" and the normaliser that erases redundant fields.
 *
 * Used by:
 *   - `server/render-tools.ts` — normalises incoming components in
 *     `render_set` and `render_append` so persisted state and the
 *     `render_update` envelope stay lean.
 *   - `src/prompts/leader-system.ts` — documents the same table to the
 *     leader so it can avoid emitting defaults in the first place
 *     (where the actual agent-side token saving happens).
 *
 * Adding a new default: add an entry to `COMPONENT_DEFAULTS` (or
 * `LAYOUT_DEFAULTS` for top-level layout) and the elision happens
 * automatically. Tests in `render-defaults.test.ts` exercise every
 * entry, so a missing test means a missing entry.
 */

import type { RenderComponent } from "./render-dsl.ts";

// ── Canonical defaults ────────────────────────────────────

/**
 * Top-level layout defaults applied by `render_set`. The agent never
 * needs to pass these explicitly.
 */
export const LAYOUT_DEFAULTS = {
  title: "",
  columns: 2,
  gap: 12,
} as const;

/**
 * Per-component-type field defaults. A field is elided iff its value
 * is strictly equal to the documented default. Fields not listed here
 * are never elided — they're either required or carry meaning when
 * present.
 *
 * `span: "auto"` is universal across every component, so it lives in a
 * shared block applied on top of the per-type table.
 */
const SPAN_DEFAULT = { span: "auto" } as const;

export const COMPONENT_DEFAULTS: Record<string, Readonly<Record<string, unknown>>> = {
  metric: { ...SPAN_DEFAULT, trend: "flat" },
  progress: { ...SPAN_DEFAULT },
  status: { ...SPAN_DEFAULT },
  text: { ...SPAN_DEFAULT },
  code: { ...SPAN_DEFAULT },
  copyable: { ...SPAN_DEFAULT },
  separator: { ...SPAN_DEFAULT },
  table: { ...SPAN_DEFAULT },
  tags: { ...SPAN_DEFAULT },
  checklist: { ...SPAN_DEFAULT },
  timeline: { ...SPAN_DEFAULT },
  diff: { ...SPAN_DEFAULT },
  list: { ...SPAN_DEFAULT, ordered: false },
  callout: { ...SPAN_DEFAULT, variant: "info" },
  kv: { ...SPAN_DEFAULT, layout: "vertical" },
  sparkline: { ...SPAN_DEFAULT, variant: "line", showRange: false },
  chart: { ...SPAN_DEFAULT, variant: "line" },
  section: { ...SPAN_DEFAULT, defaultOpen: false },
  tabs: { ...SPAN_DEFAULT },
  form: { ...SPAN_DEFAULT },
  image: { ...SPAN_DEFAULT, fit: "contain" },
  "file-preview": { ...SPAN_DEFAULT, view: "auto" },
  "html-artifact": { ...SPAN_DEFAULT },
};

// ── Elision ────────────────────────────────────────────────

/**
 * Return a copy of `c` with fields equal to their documented default
 * removed. Children of container types (`section`, `tabs`) are recursed.
 *
 * The function is pure — the input is never mutated. Unknown component
 * types fall through unchanged so additions to the schema don't crash
 * older servers; the missing-default-table case just means no elision.
 */
export function elideDefaults(c: RenderComponent): RenderComponent {
  const defaults = COMPONENT_DEFAULTS[c.type];
  if (!defaults) return c;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k in defaults && defaults[k] === v) continue;
    out[k] = v;
  }

  if (c.type === "section") {
    out["components"] = c.components.map(elideDefaults);
  } else if (c.type === "tabs") {
    out["tabs"] = c.tabs.map((tab) => ({
      ...tab,
      components: tab.components.map(elideDefaults),
    }));
  }

  return out as RenderComponent;
}

/**
 * Return `layout` without fields equal to their documented defaults, keeping
 * the `render_update` envelope minimal.
 */
export function elideLayoutDefaults(
  layout: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(layout)) {
    if (k in LAYOUT_DEFAULTS && LAYOUT_DEFAULTS[k as keyof typeof LAYOUT_DEFAULTS] === v) continue;
    out[k] = v;
  }
  return out;
}
