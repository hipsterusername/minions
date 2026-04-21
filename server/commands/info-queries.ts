/**
 * Read-only queries that simply delegate to the SDK `query()` handle:
 *   - get_context_usage
 *   - get_supported_models
 *   - get_supported_commands
 *   - get_supported_agents
 *   - get_account_info
 *   - get_mcp_server_status
 *
 * Each one is a single line of glue because `runQueryOp` handles the
 * session-lookup / queryHandle-check / response-or-error boilerplate.
 */

import { runQueryOp } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const getContextUsage: CommandHandler = (ctx, cmd, ws) =>
  runQueryOp(
    ctx,
    cmd,
    ws,
    "get_context_usage",
    (h) => (h.queryHandle ? h.queryHandle.getContextUsage() : null),
    (usage) => ({ usage }),
  );

export const getSupportedModels: CommandHandler = (ctx, cmd, ws) =>
  runQueryOp(
    ctx,
    cmd,
    ws,
    "get_supported_models",
    (h) => (h.queryHandle ? h.queryHandle.supportedModels() : null),
    (models) => ({ models }),
  );

export const getSupportedCommands: CommandHandler = (ctx, cmd, ws) =>
  runQueryOp(
    ctx,
    cmd,
    ws,
    "get_supported_commands",
    (h) => (h.queryHandle ? h.queryHandle.supportedCommands() : null),
    (commands) => ({ commands }),
  );

export const getSupportedAgents: CommandHandler = (ctx, cmd, ws) =>
  runQueryOp(
    ctx,
    cmd,
    ws,
    "get_supported_agents",
    (h) => (h.queryHandle ? h.queryHandle.supportedAgents() : null),
    (agents) => ({ agents }),
  );

export const getAccountInfo: CommandHandler = (ctx, cmd, ws) =>
  runQueryOp(
    ctx,
    cmd,
    ws,
    "get_account_info",
    (h) => (h.queryHandle ? h.queryHandle.accountInfo() : null),
    (account) => ({ account }),
  );

export const getMcpServerStatus: CommandHandler = (ctx, cmd, ws) =>
  runQueryOp(
    ctx,
    cmd,
    ws,
    "get_mcp_server_status",
    (h) => (h.queryHandle ? h.queryHandle.mcpServerStatus() : null),
    (servers) => ({ servers }),
  );
