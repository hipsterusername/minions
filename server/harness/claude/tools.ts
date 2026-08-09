/**
 * Wrap NormalizedToolDefs into an SDK MCP server instance.
 *
 * The Claude harness uses `createSdkMcpServer` + `tool()` from the Anthropic
 * SDK. This module is the only place in `server/harness/claude/` that calls
 * those helpers.
 *
 * ClaudeHarness calls this adapter for each registered internal tool group.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ZodTypeAny } from "zod/v4";
import type { NormalizedToolDef } from "../types.ts";

/** Opaque MCP server instance returned by createSdkMcpServer. */
export type McpServerInstance = ReturnType<typeof createSdkMcpServer>;

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
  // The SDK's `tool()` and `createSdkMcpServer()` are tightly typed via the
  // Anthropic SDK's MCP schema. We bridge through `unknown`/`never` casts
  // because NormalizedToolResult is a deliberately narrower shape than the
  // SDK's full MCP content union — runtime values still satisfy the SDK.
  const sdkTools = defs.map((def) => {
    const rawShape = extractShape(def);
    return tool(
      def.name,
      def.description,
      rawShape as never,
      (async (args: unknown) => def.handler(args)) as never,
    );
  }) as never;
  return createSdkMcpServer({ name: serverName, tools: sdkTools });
}

/**
 * Extract the ZodRawShape from a NormalizedToolDef's inputSchema.
 *
 * All current Minions tools use z.object({...}) as their input schema, so
 * `shape` is always present. Future tools with non-object schemas (ZodUnion,
 * ZodDiscriminatedUnion, etc.) would need a different approach — update this
 * function when that need arises.
 */
function extractShape(def: NormalizedToolDef): Record<string, ZodTypeAny> {
  const schema = def.inputSchema as { shape?: Record<string, ZodTypeAny> };
  if (schema.shape !== undefined && typeof schema.shape === "object") {
    return schema.shape;
  }
  throw new Error(
    `Tool "${def.name}": inputSchema must be a ZodObject (needs a .shape property). ` +
      `The Claude harness wraps tools via createSdkMcpServer/tool() which requires a ZodRawShape. ` +
      `Got: ${Object.getPrototypeOf(def.inputSchema as object)?.constructor?.name ?? "unknown type"}`,
  );
}
