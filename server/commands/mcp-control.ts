/**
 * MCP server controls: reconnect_mcp_server and toggle_mcp_server. Both
 * delegate to methods on the harness run control.
 *
 * Phase A: migrated from queryHandle to runControl, with the two-step check:
 * (1) no active run → "No active query", (2) method absent → unsupported.
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const reconnectMcpServer: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.serverName) {
    sendControlError(ws, "reconnect_mcp_server", host.id, cmd.requestId, "serverName required");
    return;
  }
  if (!host.runControl) {
    sendControlError(ws, "reconnect_mcp_server", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.reconnectMcpServer;
  if (!fn) {
    unsupportedByHarness(ws, "reconnect_mcp_server", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, cmd.serverName)
    .then(() => {
      sendControlResponse(ws, "reconnect_mcp_server", host.id, cmd.requestId, {
        serverName: cmd.serverName,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "reconnect_mcp_server", host.id, cmd.requestId, errToMessage(err));
    });
};

export const toggleMcpServer: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.serverName || cmd.enabled === undefined) {
    sendControlError(ws, "toggle_mcp_server", host.id, cmd.requestId, "serverName and enabled required");
    return;
  }
  if (!host.runControl) {
    sendControlError(ws, "toggle_mcp_server", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.toggleMcpServer;
  if (!fn) {
    unsupportedByHarness(ws, "toggle_mcp_server", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, cmd.serverName, cmd.enabled)
    .then(() => {
      sendControlResponse(ws, "toggle_mcp_server", host.id, cmd.requestId, {
        serverName: cmd.serverName,
        enabled: cmd.enabled,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "toggle_mcp_server", host.id, cmd.requestId, errToMessage(err));
    });
};
