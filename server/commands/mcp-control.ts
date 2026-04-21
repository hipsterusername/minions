/**
 * MCP server controls: reconnect_mcp_server and toggle_mcp_server. Both
 * delegate to methods on the SDK query handle.
 */

import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const reconnectMcpServer: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.serverName) {
    sendControlError(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, "serverName required");
    return;
  }
  if (!host.queryHandle) {
    sendControlError(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .reconnectMcpServer(cmd.serverName)
    .then(() => {
      sendControlResponse(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, {
        serverName: cmd.serverName,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};

export const toggleMcpServer: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.serverName || cmd.enabled === undefined) {
    sendControlError(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, "serverName and enabled required");
    return;
  }
  if (!host.queryHandle) {
    sendControlError(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .toggleMcpServer(cmd.serverName, cmd.enabled)
    .then(() => {
      sendControlResponse(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, {
        serverName: cmd.serverName,
        enabled: cmd.enabled,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
