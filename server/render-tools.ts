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
import type { Bus } from "./bus.ts";
import {
  renderComponentSchema,
  type RenderComponent,
} from "../shared/render-dsl.ts";
import { elideDefaults } from "../shared/render-defaults.ts";

// ── Types ─────────────────────────────────────────────

export interface RenderState {
  title: string;
  columns: number;
  gap: number;
  components: RenderComponent[];
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
    title: "",
    columns: 2,
    gap: 12,
    components: [],
  };

  function notifyStateChange(): void {
    if (!onStateChange) return;
    try {
      onStateChange(renderState);
    } catch (err) {
      console.warn("[render-tools] onStateChange failed:", err);
    }
  }

  // ── render_set ────────────────────────────────────

  const renderSetDef: NormalizedToolDef = {
    name: "render_set",
    description: "Replace the entire dashboard. Use this for initial setup or full refreshes.",
    inputSchema: z.object({
      title: z.string().optional().describe("Dashboard title"),
      columns: z.number().optional().describe("Grid columns (default 2)"),
      components: z
        .array(renderComponentSchema)
        .describe("Full component tree to display"),
    }),
    handler: async (input: unknown) => {
      const args = input as {
        title?: string;
        columns?: number;
        components: RenderComponent[];
      };
      // `set` is a full replace: title and columns both fall back to their
      // documented defaults when the agent omits them, mirroring the way
      // components is replaced wholesale.
      renderState.title = args.title ?? "";
      renderState.columns = args.columns ?? 2;
      // Strip fields equal to their documented defaults so persisted state
      // and the broadcast envelope stay lean.
      renderState.components = args.components.map(elideDefaults);

      bus.emitToSession(leaderSessionKey, {
        type: "render_update",
        leaderSessionKey,
        action: "set",
        layout: {
          title: renderState.title,
          columns: renderState.columns,
          gap: renderState.gap,
        },
        components: renderState.components,
      });

      notifyStateChange();

      return {
        content: [
          {
            type: "text" as const,
            text: `Dashboard set with ${args.components.length} component(s).`,
          },
        ],
      };
    },
  };

  // ── render_patch ──────────────────────────────────

  const renderPatchDef: NormalizedToolDef = {
    name: "render_patch",
    description: "Update specific components by id without replacing the whole dashboard.",
    inputSchema: z.object({
      updates: z
        .array(
          z
            .object({ id: z.string().describe("Component id to update") })
            .passthrough(),
        )
        .describe("Array of partial component updates, each must include id"),
    }),
    handler: async (input: unknown) => {
      const args = input as { updates: Array<Record<string, unknown>> };
      // Apply patches to local state
      for (const update of args.updates) {
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
        updates: args.updates,
      });

      notifyStateChange();

      return {
        content: [
          {
            type: "text" as const,
            text: `Patched ${args.updates.length} component(s).`,
          },
        ],
      };
    },
  };

  // ── render_append ─────────────────────────────────

  const renderAppendDef: NormalizedToolDef = {
    name: "render_append",
    description: "Add new components to the existing dashboard.",
    inputSchema: z.object({
      components: z
        .array(renderComponentSchema)
        .describe("Components to append"),
    }),
    handler: async (input: unknown) => {
      const args = input as { components: RenderComponent[] };
      // Match the client-side `applyRenderMessage("append")` semantics: a
      // component whose id already exists is treated as a replace, not a
      // duplicate.
      const elided = args.components.map(elideDefaults);
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

      return {
        content: [
          {
            type: "text" as const,
            text: `Appended ${args.components.length} component(s). Total: ${renderState.components.length}.`,
          },
        ],
      };
    },
  };

  // ── render_remove ─────────────────────────────────

  const renderRemoveDef: NormalizedToolDef = {
    name: "render_remove",
    description: "Remove components from the dashboard by their ids.",
    inputSchema: z.object({
      ids: z.array(z.string()).describe("Component ids to remove"),
    }),
    handler: async (input: unknown) => {
      const args = input as { ids: string[] };
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

      return {
        content: [
          {
            type: "text" as const,
            text: `Removed ${args.ids.length} component(s). Remaining: ${renderState.components.length}.`,
          },
        ],
      };
    },
  };

  return {
    toolDefs: [renderSetDef, renderPatchDef, renderAppendDef, renderRemoveDef],
    renderState,
  };
}
