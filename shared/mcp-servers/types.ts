/**
 * MCP server catalog types — shared between server and client.
 *
 * Entries live at `<projectPath>/.minions/mcp-servers.json`.
 * The transport field is the discriminant; the remaining fields match
 * the SDK's McpStdioServerConfig / McpSSEServerConfig / McpHttpServerConfig
 * exactly so the store can pass them straight through to `query()`.
 *
 * `toolNames` is optional. When provided the names are formatted as
 * `mcp__<id>__<toolName>` and added to the spawned leader's allowedTools
 * list so the agent may call them without hitting a permission prompt.
 * When omitted, the server still attaches but tools require an
 * auto-permission grant at call time.
 */

import { z } from "zod/v4";

// ── Per-transport entry schemas ─────────────────────────────────────────────

const baseSchema = z.object({
  /** Lower-kebab id: letters, digits, dash, underscore. */
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message:
      "id must start with a lowercase letter or digit and contain only [a-z0-9_-]",
  }),
  /** Human-readable display name shown in the UI. */
  name: z.string().min(1),
  /** Optional description shown in the browser panel. */
  description: z.string().optional(),
  /**
   * Optional list of tool names this server exposes. Each name is
   * formatted as `mcp__<id>__<toolName>` and added to allowedTools.
   */
  toolNames: z.array(z.string().min(1)).optional(),
});

export const mcpHttpEntrySchema = baseSchema.extend({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpSseEntrySchema = baseSchema.extend({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpStdioEntrySchema = baseSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * Discriminated union over all supported transports. The `transport` field
 * is the discriminant; zod picks the right branch automatically.
 */
export const mcpServerEntrySchema = z.discriminatedUnion("transport", [
  mcpHttpEntrySchema,
  mcpSseEntrySchema,
  mcpStdioEntrySchema,
]);

export type McpHttpEntry = z.infer<typeof mcpHttpEntrySchema>;
export type McpSseEntry = z.infer<typeof mcpSseEntrySchema>;
export type McpStdioEntry = z.infer<typeof mcpStdioEntrySchema>;
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

// ── Parse helpers ───────────────────────────────────────────────────────────

/** Parse or throw. Use in code paths that have already validated input. */
export function parseMcpServerEntry(value: unknown): McpServerEntry {
  return mcpServerEntrySchema.parse(value);
}

/**
 * Safe parse. Returns the entry or a list of error paths — never throws.
 * Used by the store's list operation to tolerate hand-edited files.
 */
export function safeParseMcpServerEntry(value: unknown):
  | { ok: true; entry: McpServerEntry }
  | { ok: false; errors: { path: string; message: string }[] } {
  const result = mcpServerEntrySchema.safeParse(value);
  if (result.success) return { ok: true, entry: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}
