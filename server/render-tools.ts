/**
 * Render dashboard MCP tools for the Leader agent.
 *
 * Allows the leader to push structured UI components to the frontend
 * via `render_set`, `render_patch`, `render_append`, and `render_remove`.
 *
 * Each mutation emits a `render_update` envelope on the leader's session
 * topic via the shared `Bus` — see `server/bus.ts`. The component schema
 * is imported from `shared/render-dsl.ts`, which is the single source of
 * truth consumed by both server and client.
 *
 * Returns NormalizedToolDef[] which agents/leader.ts places into a toolGroup
 * keyed "render-dashboard". ClaudeHarness.registerTools() wraps them as a
 * named MCP server so tool calls follow the mcp__render-dashboard__* pattern.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import { textResult } from "./harness/tool-result.ts";
import type { Bus } from "./bus.ts";
import {
  renderComponentInputSchema,
  renderComponentSchema,
  type RenderComponent,
  type RenderState,
} from "../shared/render-dsl.ts";
import { elideDefaults } from "../shared/render-defaults.ts";
import { sanitizeToSandboxDocument } from "./html-sanitize.ts";
import { createPublishHtmlToolDef } from "./render-html-tool.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("render-tools");

// RenderState is imported from shared/render-dsl.ts — single source of truth.
export type { RenderState };

const DASHBOARD_COMPONENT_GUIDE = [
  "The dashboard is a live side panel for showing progress, evidence, results, choices, and review data while the agent works.",
  "Use structured Render DSL components, not arbitrary HTML/React. Every component is a JSON object with stable id and type; never pass stringified JSON, HTML, markdown, or JSX as a component.",
  "Cell-width types: metric(label,value), progress(label,value 0-100), status(label,state success|error|warning|running|pending), sparkline(data), kv(entries), checklist(items), tags(items).",
  "Full-width types: table(headers,rows), list(items), text(content), code(content), copyable(content), timeline(events), callout(variant,content), diff(before,after), separator.",
  "Rich types: form(fields) for user input, chart(series) for SVG charts, section(components) and tabs(tabs[].components) for layout, image(src,alt), file-preview(source). Image src must be an embedded PNG/JPEG/GIF/WebP data URL; external URLs are rejected. Path file previews are display/copy-only and cannot open or download arbitrary paths.",
  "html-artifact(html,title?) shows a static, NON-FUNCTIONAL HTML visualization in a locked-down sandboxed iframe with click-to-expand. Prefer the dedicated `publish_html` tool to create one — it sanitizes the HTML and writes a session-scoped temp file. Never rely on scripts, forms, or network requests inside it.",
  "Use render_set for initial layout, then render_patch with stable ids for value/state updates.",
].join(" ");

const renderSetInputSchema = z.object({
  title: z.string().optional().describe("Dashboard title"),
  columns: z.number().optional().describe("Grid columns (default 2)"),
  components: z
    .array(renderComponentInputSchema)
    .describe(
      "Full component tree to display. Each entry must be a JSON object with id/type, never a string of JSON, HTML, or markdown.",
    ),
});

const renderAppendInputSchema = z.object({
  components: z
    .array(renderComponentInputSchema)
    .describe(
      "Components to append. Each entry must be a JSON object with id/type, never a string of JSON, HTML, or markdown.",
    ),
});

function parseRenderComponent(component: unknown): RenderComponent {
  const parsed = renderComponentSchema.parse(component) as RenderComponent;
  if (parsed.type === "section") {
    return {
      ...parsed,
      components: parseRenderComponents(parsed.components),
    };
  }
  if (parsed.type === "tabs") {
    return {
      ...parsed,
      tabs: parsed.tabs.map((tab) => ({
        ...tab,
        components: parseRenderComponents(tab.components),
      })),
    };
  }
  // Security chokepoint: every `html-artifact` that flows through the render
  // tools is reduced to a non-functional, CSP-wrapped, script-free document
  // before it can reach a client. `sanitizeToSandboxDocument` is idempotent,
  // so content already sanitized by `publish_html` passes through unchanged.
  if (parsed.type === "html-artifact") {
    return { ...parsed, html: sanitizeToSandboxDocument(parsed.html) };
  }
  return parsed;
}

function parseRenderComponents(components: unknown[]): RenderComponent[] {
  return components.map(parseRenderComponent);
}

// ── Factory ───────────────────────────────────────────

/**
 * Create render dashboard tool definitions bound to a specific leader session.
 *
 * Returns:
 *  - `toolDefs` — flat NormalizedToolDef[] to pass to wrapTools().
 *  - `renderState` so the server can inspect the dashboard externally.
 */
export function createRenderToolsForLeader(opts: {
  leaderSessionKey: string;
  bus: Bus;
  /**
   * Optional callback fired after every render-state mutation. The persistence
   * layer uses this to write the dashboard to SQLite (Phase 4.4).
   */
  onStateChange?: (state: RenderState) => void;
  /** Optional initial state to preserve across resume calls */
  existingRenderState?: RenderState;
}): { toolDefs: NormalizedToolDef[]; renderState: RenderState } {
  const { leaderSessionKey, bus, onStateChange } = opts;

  const renderState: RenderState = opts.existingRenderState ?? {
    layout: { title: "", columns: 2, gap: 12 },
    components: [],
  };

  function notifyStateChange(): void {
    if (!onStateChange) return;
    try {
      onStateChange(renderState);
    } catch (err) {
      log.warn("state_change_callback_failed", { error: err });
    }
  }

  /**
   * Shared append primitive: elide defaults, merge into state (id-collision =
   * replace, matching the client reducer), broadcast the append envelope, and
   * persist. Callers pass already-parsed/sanitized components. Reused by both
   * `render_append` and the `publish_html` tool.
   */
  function appendComponents(components: RenderComponent[]): void {
    const elided = components.map(elideDefaults);
    const incomingIds = new Set(elided.map((c) => c.id));
    renderState.components = [
      ...renderState.components.filter((c) => !incomingIds.has(c.id)),
      ...elided,
    ];

    bus.emitToSession(leaderSessionKey, {
      type: "render_update",
      leaderSessionKey,
      action: "append",
      components: elided,
    });

    notifyStateChange();
  }

  // ── render_set ────────────────────────────────────

  const renderSetDef: NormalizedToolDef = {
    name: "render_set",
    description: `Replace the entire dashboard. Use this for initial setup or full refreshes. ${DASHBOARD_COMPONENT_GUIDE}`,
    inputSchema: renderSetInputSchema,
    handler: async (input: unknown) => {
      const parsed = renderSetInputSchema.parse(input);
      const args = {
        ...parsed,
        components: parseRenderComponents(parsed.components),
      };
      // `set` is a full replace: title and columns both fall back to their
      // documented defaults when the agent omits them, mirroring the way
      // components is replaced wholesale.
      renderState.layout.title = args.title ?? "";
      renderState.layout.columns = args.columns ?? 2;
      // Strip fields equal to their documented defaults so persisted state
      // and the broadcast envelope stay lean.
      renderState.components = args.components.map(elideDefaults);

      bus.emitToSession(leaderSessionKey, {
        type: "render_update",
        leaderSessionKey,
        action: "set",
        layout: {
          title: renderState.layout.title,
          columns: renderState.layout.columns,
          gap: renderState.layout.gap,
        },
        components: renderState.components,
      });

      notifyStateChange();

      return textResult(
        `Dashboard set with ${args.components.length} component(s).`,
      );
    },
  };

  // ── render_patch ──────────────────────────────────

  const renderPatchInputSchema = z.object({
    updates: z
      .array(
        z
          .object({ id: z.string().describe("Component id to update") })
          .passthrough(),
      )
      .describe("Array of partial component updates, each must include id"),
  });

  const renderPatchDef: NormalizedToolDef = {
    name: "render_patch",
    description:
      "Update specific components by id without replacing the whole dashboard. Use for live progress updates: status state, metric values, progress percentages, chart data, checklist items, or concise text changes. Patch entries are partial component objects with id; the existing component id/type are preserved.",
    inputSchema: renderPatchInputSchema,
    handler: async (input: unknown) => {
      const args = renderPatchInputSchema.parse(input);
      // Security chokepoint: any patch that carries an `html` string (only
      // `html-artifact` uses that field) is sanitized before it is applied to
      // state OR broadcast — the patch envelope ships these updates verbatim.
      const updates = args.updates.map((update) =>
        typeof update["html"] === "string"
          ? { ...update, html: sanitizeToSandboxDocument(update["html"]) }
          : update,
      );
      // Apply patches to local state
      for (const update of updates) {
        const idx = renderState.components.findIndex(
          (c) => c.id === update["id"],
        );
        if (idx !== -1) {
          const existing = renderState.components[idx]!;
          renderState.components[idx] = elideDefaults({
            ...existing,
            ...update,
            id: existing.id,
            type: existing.type,
          } as RenderComponent);
        }
      }

      bus.emitToSession(leaderSessionKey, {
        type: "render_update",
        leaderSessionKey,
        action: "patch",
        updates,
      });

      notifyStateChange();

      return textResult(`Patched ${args.updates.length} component(s).`);
    },
  };

  // ── render_append ─────────────────────────────────

  const renderAppendDef: NormalizedToolDef = {
    name: "render_append",
    description:
      "Add new components to the existing dashboard without replacing the layout. Components follow the same Render DSL contract documented on render_set; a component whose id already exists is replaced in place.",
    inputSchema: renderAppendInputSchema,
    handler: async (input: unknown) => {
      const parsed = renderAppendInputSchema.parse(input);
      // Match the client-side `applyRenderMessage("append")` semantics: a
      // component whose id already exists is treated as a replace, not a
      // duplicate. `appendComponents` handles elision, state, and broadcast.
      const components = parseRenderComponents(parsed.components);
      appendComponents(components);

      return textResult(
        `Appended ${components.length} component(s). Total: ${renderState.components.length}.`,
      );
    },
  };

  // ── render_remove ─────────────────────────────────

  const renderRemoveInputSchema = z.object({
    ids: z.array(z.string()).describe("Component ids to remove"),
  });

  const renderRemoveDef: NormalizedToolDef = {
    name: "render_remove",
    description:
      "Remove components from the dashboard by their ids. Use when a temporary status, section, tab, or result is no longer relevant.",
    inputSchema: renderRemoveInputSchema,
    handler: async (input: unknown) => {
      const args = renderRemoveInputSchema.parse(input);
      const idSet = new Set(args.ids);
      renderState.components = renderState.components.filter(
        (c) => !idSet.has(c.id),
      );

      bus.emitToSession(leaderSessionKey, {
        type: "render_update",
        leaderSessionKey,
        action: "remove",
        ids: args.ids,
      });

      notifyStateChange();

      return textResult(
        `Removed ${args.ids.length} component(s). Remaining: ${renderState.components.length}.`,
      );
    },
  };

  // ── publish_html ──────────────────────────────────
  // A convenience tool that sanitizes + persists a temp file + appends an
  // `html-artifact`. Lives in its own module to keep this file within the
  // 400-line server budget; it shares this closure's `appendComponents`.
  const publishHtmlDef = createPublishHtmlToolDef({
    leaderSessionKey,
    appendComponents,
  });

  return {
    toolDefs: [
      renderSetDef,
      renderPatchDef,
      renderAppendDef,
      renderRemoveDef,
      publishHtmlDef,
    ],
    renderState,
  };
}
