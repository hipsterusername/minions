/**
 * sync_session — return a snapshot of one session plus its buffered events.
 *
 * Used by the client on reconnect and on focus to catch up after a dropped
 * WebSocket connection. If the session carries render state, re-emit it as
 * a `render_update` so the RenderNode subscription picks it up.
 */

import { unicastToSession } from "../bus.ts";
import { getHarness } from "../harness/index.ts";
import type { HarnessCapabilities } from "../harness/types.ts";
import type { CommandHandler } from "./types.ts";

/**
 * Look up the host's current harness so the client can render
 * harness-aware controls without a separate round-trip.
 *
 * Returns `null` for `capabilities` when the harness is unregistered
 * (e.g. a hydrated session whose harness module was removed) — the
 * client treats `null` capabilities as "fall back to safe defaults"
 * rather than throwing.
 */
function harnessSnapshot(name: string): {
  harness: string;
  harnessCapabilities: HarnessCapabilities | null;
} {
  try {
    const h = getHarness(name);
    return { harness: name, harnessCapabilities: h.capabilities };
  } catch {
    return { harness: name, harnessCapabilities: null };
  }
}

export const syncSession: CommandHandler = (ctx, cmd, ws) => {
  if (!cmd.sessionKey) return;
  const host = ctx.registry.get(cmd.sessionKey);
  if (!host) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "sync_response",
      sessionKey: cmd.sessionKey,
      found: false,
    });
    return;
  }

  const { harness, harnessCapabilities } = harnessSnapshot(host.harnessName);

  unicastToSession(ws, cmd.sessionKey, {
    type: "sync_response",
    sessionKey: cmd.sessionKey,
    found: true,
    status: host.status,
    sessionId: host.sessionId,
    cwd: host.cwd,
    totalCost: host.totalCost,
    turns: host.turns,
    usageTotals: host.usageTotals,
    lastError: host.lastError,
    lastErrorFull: host.lastErrorFull,
    model: host.model,
    permissionMode: host.permissionMode,
    initData: host.initData,
    worktree: host.worktree,
    approval: host.taskState?.approval ?? null,
    taskPlan: host.taskState ? Array.from(host.taskState.tasks.values()) : [],
    renderState: host.renderState ?? null,
    taskName: host.taskName,
    role: host.role,
    harness,
    harnessCapabilities,
    activeMinions: host.taskState
      ? Array.from(host.taskState.tasks.entries())
          .filter(
            ([, t]) =>
              t.status === "planned" ||
              t.status === "starting" ||
              t.status === "running",
          )
          .map(([id, t]) => ({
            taskId: id,
            title: t.title,
            status: t.status,
            sessionKey: t.minionSessionKey,
          }))
      : [],
    events: host.eventBuffer,
  });

  // Re-emit render state so the RenderNode subscription picks it up on
  // reconnect / refresh.
  if (host.renderState && host.renderState.components.length > 0) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "render_update",
      leaderSessionKey: cmd.sessionKey,
      action: "set",
      layout: {
        title: host.renderState.layout.title,
        columns: host.renderState.layout.columns,
        gap: host.renderState.layout.gap,
      },
      components: host.renderState.components,
    });
  }
};
