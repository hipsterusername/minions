/**
 * Read-only info queries.
 *
 * Split into two groups after Phase A:
 *
 * Run-dependent (route through host.runControl):
 *   - get_context_usage      → runControl.getContextUsage()
 *   - get_usage_report       → runControl.getUsageReport()
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
import { unicastGlobal } from "../bus.ts";
import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";
import type { SessionHost } from "../session-host.ts";

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

export const getUsageReport: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.runControl) {
    sendControlError(ws, "get_usage_report", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.getUsageReport;
  if (!fn) {
    unsupportedByHarness(ws, "get_usage_report", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl)
    .then((usage) =>
      sendControlResponse(ws, "get_usage_report", host.id, cmd.requestId, { usage }),
    )
    .catch((err: unknown) =>
      sendControlError(ws, "get_usage_report", host.id, cmd.requestId, errToMessage(err)),
    );
};

export const getProviderUsageReport: CommandHandler = (ctx, cmd, ws) => {
  const harnessName = cmd.harness;
  if (!harnessName) {
    unicastGlobal(ws, {
      type: "control_response",
      command: "get_provider_usage_report",
      sessionKey: null,
      requestId: cmd.requestId ?? null,
      success: false,
      error: "harness required",
    });
    return;
  }

  const liveHost = newestLiveUsageHost([...ctx.registry.values()], harnessName);
  if (liveHost?.runControl?.getUsageReport) {
    liveHost.runControl.getUsageReport()
      .then((usage) =>
        unicastGlobal(ws, {
          type: "control_response",
          command: "get_provider_usage_report",
          sessionKey: liveHost.id,
          requestId: cmd.requestId ?? null,
          success: true,
          provider: harnessName,
          usage,
        }),
      )
      .catch((err: unknown) =>
        unicastGlobal(ws, {
          type: "control_response",
          command: "get_provider_usage_report",
          sessionKey: liveHost.id,
          requestId: cmd.requestId ?? null,
          success: false,
          provider: harnessName,
          error: errToMessage(err),
        }),
      );
    return;
  }

  let harness;
  try {
    harness = getHarness(harnessName);
  } catch (err: unknown) {
    unicastGlobal(ws, {
      type: "control_response",
      command: "get_provider_usage_report",
      sessionKey: null,
      requestId: cmd.requestId ?? null,
      success: false,
      provider: harnessName,
      error: errToMessage(err),
    });
    return;
  }

  if (!harness.getUsageReport) {
    unicastGlobal(ws, {
      type: "control_response",
      command: "get_provider_usage_report",
      sessionKey: null,
      requestId: cmd.requestId ?? null,
      success: false,
      provider: harnessName,
      error: `No live ${harnessName} query exposes a usage report.`,
    });
    return;
  }

  harness.getUsageReport()
    .then((usage) =>
      unicastGlobal(ws, {
        type: "control_response",
        command: "get_provider_usage_report",
        sessionKey: null,
        requestId: cmd.requestId ?? null,
        success: true,
        provider: harnessName,
        usage,
      }),
    )
    .catch((err: unknown) =>
      unicastGlobal(ws, {
        type: "control_response",
        command: "get_provider_usage_report",
        sessionKey: null,
        requestId: cmd.requestId ?? null,
        success: false,
        provider: harnessName,
        error: errToMessage(err),
      }),
    );
};

function newestLiveUsageHost(hosts: SessionHost[], harnessName: string): SessionHost | null {
  return hosts
    .filter((host) => host.harnessName === harnessName)
    .filter((host) => host.runControl?.getUsageReport)
    .sort((a, b) => lastActivityAt(b) - lastActivityAt(a))[0] ?? null;
}

function lastActivityAt(host: SessionHost): number {
  for (let i = host.eventBuffer.length - 1; i >= 0; i -= 1) {
    const timestamp = host.eventBuffer[i]?.timestamp;
    if (typeof timestamp === "number") return timestamp;
  }
  return 0;
}

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
