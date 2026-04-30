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
 */

import { z } from "zod/v4";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "./bus.ts";
import {
  renderComponentSchema,
  type RenderComponent,
} from "../shared/render-dsl.ts";

// ── Types ─────────────────────────────────────────────

export interface RenderState {
  title: string;
  columns: number;
  gap: number;
  components: RenderComponent[];
}

// ── Factory ───────────────────────────────────────────

/**
 * Create render dashboard MCP tools bound to a specific leader session.
 *
 * Returns:
 *  - `mcpServer` config to pass into `query()` options.mcpServers
 *  - `renderState` so the server can inspect the dashboard externally
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
}) {
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
  const renderSetTool = tool(
    "render_set",
    "Replace the entire dashboard. Use this for initial setup or full refreshes.",
    {
      title: z.string().optional().describe("Dashboard title"),
      columns: z.number().optional().describe("Grid columns (default 2)"),
      components: z
        .array(renderComponentSchema)
        .describe("Full component tree to display"),
    },
    async (args) => {
      // `set` is a full replace: title and columns both fall back to their
      // documented defaults when the agent omits them, mirroring the way
      // components is replaced wholesale. (Earlier code preserved title but
      // reset columns, which was inconsistent.)
      renderState.title = args.title ?? "";
      renderState.columns = args.columns ?? 2;
      renderState.components = args.components;

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
  );

  // ── render_patch ──────────────────────────────────
  const renderPatchTool = tool(
    "render_patch",
    "Update specific components by id without replacing the whole dashboard.",
    {
      updates: z
        .array(
          z
            .object({ id: z.string().describe("Component id to update") })
            .passthrough(),
        )
        .describe("Array of partial component updates, each must include id"),
    },
    async (args) => {
      // Apply patches to local state
      for (const update of args.updates) {
        const idx = renderState.components.findIndex(
          (c) => c.id === update["id"],
        );
        if (idx !== -1) {
          const existing = renderState.components[idx]!;
          // Merge update into component, preserving id and type — they
          // must not change via patch. We cast to RenderComponent because
          // the merged object retains the original discriminant.
          renderState.components[idx] = {
            ...existing,
            ...update,
            id: existing.id,
            type: existing.type,
          } as RenderComponent;
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
  );

  // ── render_append ─────────────────────────────────
  const renderAppendTool = tool(
    "render_append",
    "Add new components to the existing dashboard.",
    {
      components: z
        .array(renderComponentSchema)
        .describe("Components to append"),
    },
    async (args) => {
      // Match the client-side `applyRenderMessage("append")` semantics: a
      // component whose id already exists is treated as a replace, not a
      // duplicate. Without this the server's persisted state diverges from
      // the dashboard the user actually sees.
      const incomingIds = new Set(args.components.map((c) => c.id));
      renderState.components = [
        ...renderState.components.filter((c) => !incomingIds.has(c.id)),
        ...args.components,
      ];

      bus.emitToSession(leaderSessionKey, {
        type: "render_update",
        leaderSessionKey,
        action: "append",
        components: args.components,
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
  );

  // ── render_remove ─────────────────────────────────
  const renderRemoveTool = tool(
    "render_remove",
    "Remove components from the dashboard by their ids.",
    {
      ids: z.array(z.string()).describe("Component ids to remove"),
    },
    async (args) => {
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
  );

  // ── Build MCP server ───────────────────────────────

  const tools = [
    renderSetTool,
    renderPatchTool,
    renderAppendTool,
    renderRemoveTool,
  ] as const;

  const mcpServer = createSdkMcpServer({
    name: "render-dashboard",
    tools: [...tools],
  });

  // `tools` is exposed alongside `mcpServer` so tests (and any future
  // in-process driver) can invoke handlers directly without spinning up
  // an MCP transport.
  return { mcpServer, tools, renderState };
}
