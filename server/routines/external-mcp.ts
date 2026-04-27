/**
 * Build external MCP server configs from a list of mcpServerIds.
 *
 * Called by `leader-runner.ts` at step-spawn time. Resolves IDs against
 * the project's `.claude-canvas/mcp-servers.json`, converts each entry to
 * the SDK-compatible format, and collects tool names for `allowedTools`.
 * Unknown IDs are silently dropped.
 *
 * The SDK accepts:
 *   - `McpStdioServerConfig`  { command, args?, env? }
 *   - `McpSSEServerConfig`    { type: "sse", url, headers? }
 *   - `McpHttpServerConfig`   { type: "http", url, headers? }
 *
 * Tool names, when provided in the entry, are formatted as
 * `mcp__<serverId>__<toolName>` to match the SDK's naming convention.
 */

import { loadMcpServersByIds } from "../mcp-server-store.ts";
import type { McpServerEntry } from "../../shared/mcp-servers/types.ts";

/** SDK-compatible config for one MCP server (no live instance required). */
type ExternalMcpConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface ExternalMcpResult {
  /** Server name → SDK-compatible config, ready to merge into `mcpServers`. */
  mcpServers: Record<string, ExternalMcpConfig>;
  /** Formatted tool names for `allowedTools` (may be empty). */
  toolNames: string[];
}

/**
 * Convert a single entry to the SDK's expected config shape.
 * The `transport` field is the store's discriminant; the SDK uses `type`.
 * For stdio the type field is optional (SDK defaults to stdio).
 */
function toSdkConfig(entry: McpServerEntry): ExternalMcpConfig {
  if (entry.transport === "stdio") {
    const config: { command: string; args?: string[]; env?: Record<string, string> } = {
      command: entry.command,
    };
    if (entry.args?.length) config.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) config.env = entry.env;
    return config;
  }
  if (entry.transport === "sse") {
    const config: { type: "sse"; url: string; headers?: Record<string, string> } = {
      type: "sse",
      url: entry.url,
    };
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      config.headers = entry.headers;
    }
    return config;
  }
  // http
  const config: { type: "http"; url: string; headers?: Record<string, string> } = {
    type: "http",
    url: entry.url,
  };
  if (entry.headers && Object.keys(entry.headers).length > 0) {
    config.headers = entry.headers;
  }
  return config;
}

/**
 * Format declared tool names as `mcp__<serverId>__<toolName>` to match
 * the SDK's allowedTools naming convention.
 */
function formatToolNames(serverId: string, toolNames?: string[]): string[] {
  if (!toolNames || toolNames.length === 0) return [];
  return toolNames.map((t) => `mcp__${serverId}__${t}`);
}

/**
 * Build external MCP server configs from a list of IDs. Unknown IDs are
 * silently dropped. Returns an empty result when `ids` is empty.
 */
export function buildExternalMcpServers(
  projectPath: string,
  ids: readonly string[],
): ExternalMcpResult {
  if (ids.length === 0) return { mcpServers: {}, toolNames: [] };

  const entries = loadMcpServersByIds(projectPath, ids);
  const mcpServers: Record<string, ExternalMcpConfig> = {};
  const toolNames: string[] = [];

  for (const entry of entries) {
    mcpServers[entry.id] = toSdkConfig(entry);
    toolNames.push(...formatToolNames(entry.id, entry.toolNames));
  }

  return { mcpServers, toolNames };
}
