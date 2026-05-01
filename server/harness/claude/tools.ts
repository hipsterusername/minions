/**
 * Wrap NormalizedToolDefs into an SDK MCP server instance.
 *
 * The Claude harness uses `createSdkMcpServer` + `tool()` from the Anthropic
 * SDK. This module is the only place in `server/harness/claude/` that calls
 * those helpers.
 *
 * Phase 1: standalone module, not yet wired into session-host.ts.
 * Phase 4 will make all tool files export NormalizedToolDef and route through
 * here, at which point the architecture test added in Phase 2 fully passes.
 *
 * See docs/model-agnosticism-spec.md §3.4 and Phase 1.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedToolDef } from "../types.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Opaque MCP server instance returned by createSdkMcpServer. */
export type McpServerInstance = ReturnType<typeof createSdkMcpServer>;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wrap a flat list of NormalizedToolDefs into a single MCP server.
 *
 * Each def's `inputSchema` must be a ZodObject — `tool()` from the SDK
 * requires a `ZodRawShape` (the `.shape` property of a ZodObject), not a
 * top-level ZodType. If a schema is not a ZodObject this function throws
 * with a clear message.
 *
 * @param serverName  MCP server name, e.g. "task-manager".
 * @param defs        Tool definitions to wrap.
 */
export function wrapTools(serverName: string, defs: NormalizedToolDef[]): McpServerInstance {
  const sdkTools = defs.map((def) => {
    const rawShape = extractShape(def);
    return tool(def.name, def.description, rawShape, async (args) => {
      return await def.handler(args as unknown);
    });
  });
  return createSdkMcpServer({ name: serverName, tools: sdkTools });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the ZodRawShape from a NormalizedToolDef's inputSchema.
 *
 * All current Minions tools use z.object({...}) as their input schema, so
 * `shape` is always present. Future tools with non-object schemas (ZodUnion,
 * ZodDiscriminatedUnion, etc.) would need a different approach — update this
 * function when that need arises.
 */
function extractShape(def: NormalizedToolDef): Record<string, unknown> {
  const schema = def.inputSchema as { shape?: Record<string, unknown> };
  if (schema.shape !== undefined && typeof schema.shape === "object") {
    return schema.shape;
  }
  throw new Error(
    `Tool "${def.name}": inputSchema must be a ZodObject (needs a .shape property). ` +
      `The Claude harness wraps tools via createSdkMcpServer/tool() which requires a ZodRawShape. ` +
      `Got: ${Object.getPrototypeOf(def.inputSchema as object)?.constructor?.name ?? "unknown type"}`,
  );
}
