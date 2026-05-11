/**
 * Read-only info queries.
 *
 * Split into two groups after Phase A:
 *
 * Run-dependent (route through host.runControl):
 *   - get_context_usage      → runControl.getContextUsage()
 *   - get_mcp_server_status  → runControl.mcpServerStatus()
 *
 * Run-independent (route through harness.staticInfo()):
 *   - get_supported_models   → harness.staticInfo().models
 *   - get_supported_commands → harness.staticInfo().commands
 *   - get_supported_agents   → harness.staticInfo().agents
 *   - get_account_info       → harness.staticInfo().account
 *
 * The staticInfo queries work even when no run is live, so they never
 * return "No active query".
 */

import { getHarness } from "../harness/index.ts";
import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

// ── Run-dependent queries ─────────────────────────────────────

export const getContextUsage: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.runControl) {
    sendControlError(ws, "get_context_usage", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.getContextUsage;
  if (!fn) {
    unsupportedByHarness(ws, "get_context_usage", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl)
    .then((usage) =>
      sendControlResponse(ws, "get_context_usage", host.id, cmd.requestId, { usage }),
    )
    .catch((err: unknown) =>
      sendControlError(ws, "get_context_usage", host.id, cmd.requestId, errToMessage(err)),
    );
};

export const getMcpServerStatus: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.runControl) {
    sendControlError(ws, "get_mcp_server_status", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.mcpServerStatus;
  if (!fn) {
    unsupportedByHarness(ws, "get_mcp_server_status", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl)
    .then((servers) =>
      sendControlResponse(ws, "get_mcp_server_status", host.id, cmd.requestId, { servers }),
    )
    .catch((err: unknown) =>
      sendControlError(ws, "get_mcp_server_status", host.id, cmd.requestId, errToMessage(err)),
    );
};

// ── Run-independent queries (harness.staticInfo()) ────────────

export const getSupportedModels: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const harness = getHarness(host.harnessName);
  sendControlResponse(ws, "get_supported_models", host.id, cmd.requestId, {
    models: harness.staticInfo().models,
  });
};

export const getSupportedCommands: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const harness = getHarness(host.harnessName);
  sendControlResponse(ws, "get_supported_commands", host.id, cmd.requestId, {
    commands: harness.staticInfo().commands,
  });
};

export const getSupportedAgents: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const harness = getHarness(host.harnessName);
  sendControlResponse(ws, "get_supported_agents", host.id, cmd.requestId, {
    agents: harness.staticInfo().agents,
  });
};

export const getAccountInfo: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const harness = getHarness(host.harnessName);
  sendControlResponse(ws, "get_account_info", host.id, cmd.requestId, {
    account: harness.staticInfo().account,
  });
};
