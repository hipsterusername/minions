/**
 * Container components for the render DSL — `section` (collapsible group) and
 * `tabs` (tabbed panel). These hold other RenderComponents recursively, enabling
 * drill-down dashboards without token explosion.
 *
 * **Recursive typing strategy:** Zod's `discriminatedUnion` does not compose
 * with `z.lazy`. We validate each container's own fields strictly, but type
 * children as `z.unknown()` at parse time. The TypeScript interfaces are
 * recursive via the imported `RenderComponent` union — when containers are
 * added to that union in a future integration step, full nesting will be
 * validated end-to-end automatically.
 */

import { z } from "zod/v4";
import { spanSchema } from "./render-base.ts";
import type { ComponentSpan } from "./render-base.ts";
// `RenderComponent` lives in render-dsl.ts and the union there imports
// these container schemas. The cycle is type-only (no runtime value
// import), which TypeScript handles via `import type`.
import type { RenderComponent } from "./render-dsl.ts";

// Children schema is loose at parse time to avoid z.lazy + discriminatedUnion
// incompatibility. Runtime validation of nested children is a no-op for v1.
const childComponentSchemaLoose = z.unknown();

// ── Section ────────────────────────────────────────────────

export const sectionComponentSchema = z.object({
  id: z.string(),
  type: z.literal("section"),
  title: z.string(),
  defaultOpen: z.boolean().optional(),
  badge: z.string().optional(),
  components: z.array(childComponentSchemaLoose),
  span: spanSchema.optional(),
});

// ── Tabs ───────────────────────────────────────────────────

export const tabSchema = z.object({
  id: z.string(),
  label: z.string(),
  badge: z.string().optional(),
  components: z.array(childComponentSchemaLoose),
});

export const tabsComponentSchema = z.object({
  id: z.string(),
  type: z.literal("tabs"),
  activeTabId: z.string().optional(),
  tabs: z.array(tabSchema),
  span: spanSchema.optional(),
});

// ── TypeScript types (recursive via RenderComponent) ──────

// Optional fields use `T | undefined` explicitly so the manual interfaces
// stay assignable from the zod-inferred shapes under
// `exactOptionalPropertyTypes: true`.
export interface SectionComponent {
  id: string;
  type: "section";
  title: string;
  defaultOpen?: boolean | undefined;
  badge?: string | undefined;
  components: RenderComponent[];
  span?: ComponentSpan | undefined;
}

export interface TabItem {
  id: string;
  label: string;
  badge?: string | undefined;
  components: RenderComponent[];
}

export interface TabsComponent {
  id: string;
  type: "tabs";
  activeTabId?: string | undefined;
  tabs: TabItem[];
  span?: ComponentSpan | undefined;
}

// ── Markdown format helpers ────────────────────────────────

/**
 * Flatten a section to markdown: title as h2, children formatted below.
 * Pass the shared `formatChild` callback so the caller controls leaf rendering.
 */
export function formatSection(
  c: SectionComponent,
  formatChild: (child: RenderComponent) => string,
): string {
  const body = c.components.map(formatChild).join("\n\n");
  return `## ${c.title}\n\n${body}`;
}

/**
 * Flatten a tabs component to markdown: each tab as h3 with its children below.
 * Pass the shared `formatChild` callback so the caller controls leaf rendering.
 */
export function formatTabs(
  c: TabsComponent,
  formatChild: (child: RenderComponent) => string,
): string {
  return c.tabs
    .map((tab) => {
      const body = tab.components.map(formatChild).join("\n\n");
      return `### ${tab.label}\n\n${body}`;
    })
    .join("\n\n");
}
