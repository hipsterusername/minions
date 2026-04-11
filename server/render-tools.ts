/**
 * Render dashboard MCP tools for the Leader agent.
 *
 * Allows the leader to push structured UI components to the frontend
 * via `render_set`, `render_patch`, `render_append`, and `render_remove`.
 *
 * Each mutation broadcasts a `render_update` event over WebSocket so the
 * frontend can render a live dashboard for the leader session.
 */

import { z } from "zod/v4";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocketServer, WebSocket } from "ws";

// ── Types ─────────────────────────────────────────────

export interface RenderState {
  title: string;
  columns: number;
  gap: number;
  components: Record<string, unknown>[];
}

// ── Broadcast helper ──────────────────────────────────

function broadcast(wss: WebSocketServer, data: unknown): void {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if ((client as WebSocket).readyState === 1 /* OPEN */) {
      (client as WebSocket).send(msg);
    }
  }
}

// ── Component schema ──────────────────────────────────

const componentSchema = z
  .object({
    id: z.string().describe("Unique component id"),
    type: z
      .enum(["metric", "progress", "table", "list", "text", "status", "code"])
      .describe("Component type"),
  })
  .passthrough();

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
  wss: WebSocketServer;
}) {
  const { leaderSessionKey, wss } = opts;

  const renderState: RenderState = {
    title: "",
    columns: 2,
    gap: 12,
    components: [],
  };

  // ── render_set ────────────────────────────────────
  const renderSetTool = tool(
    "render_set",
    "Replace the entire dashboard. Use this for initial setup or full refreshes.",
    {
      title: z.string().optional().describe("Dashboard title"),
      columns: z.number().optional().describe("Grid columns (default 2)"),
      components: z
        .array(componentSchema)
        .describe("Full component tree to display"),
    },
    async (args) => {
      renderState.title = args.title ?? renderState.title;
      renderState.columns = args.columns ?? 2;
      renderState.components = args.components;

      broadcast(wss, {
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
          (c) => c.id === update.id,
        );
        if (idx !== -1) {
          const existing = renderState.components[idx];
          renderState.components[idx] = {
            ...existing,
            ...update,
            // Preserve id and type — they must not change via patch
            id: existing.id,
            type: existing.type,
          };
        }
      }

      broadcast(wss, {
        type: "render_update",
        leaderSessionKey,
        action: "patch",
        updates: args.updates,
      });

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
        .array(componentSchema)
        .describe("Components to append"),
    },
    async (args) => {
      renderState.components.push(...args.components);

      broadcast(wss, {
        type: "render_update",
        leaderSessionKey,
        action: "append",
        components: args.components,
      });

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
        (c) => !idSet.has(c.id as string),
      );

      broadcast(wss, {
        type: "render_update",
        leaderSessionKey,
        action: "remove",
        ids: args.ids,
      });

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

  const mcpServer = createSdkMcpServer({
    name: "render-dashboard",
    tools: [renderSetTool, renderPatchTool, renderAppendTool, renderRemoveTool],
  });

  return { mcpServer, renderState };
}
