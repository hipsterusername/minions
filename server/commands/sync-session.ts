/**
 * sync_session — return a snapshot of one session plus its buffered events.
 *
 * Used by the client on reconnect and on focus to catch up after a dropped
 * WebSocket connection. If the session carries render state, re-emit it as
 * a `render_update` so the RenderNode subscription picks it up.
 */

import { unicastToSession } from "../bus.ts";
import type { CommandHandler } from "./types.ts";

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

  unicastToSession(ws, cmd.sessionKey, {
    type: "sync_response",
    sessionKey: cmd.sessionKey,
    found: true,
    status: host.status,
    sessionId: host.sessionId,
    cwd: host.cwd,
    totalCost: host.totalCost,
    turns: host.turns,
    lastError: host.lastError,
    model: host.model,
    permissionMode: host.permissionMode,
    initData: host.initData,
    worktree: host.worktree,
    approval: host.taskState?.approval ?? null,
    renderState: host.renderState ?? null,
    taskName: host.taskName,
    role: host.role,
    activeMinions: host.taskState
      ? Array.from(host.taskState.tasks.entries())
          .filter(([, t]) => t.status === "planned" || t.status === "running")
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
        title: host.renderState.title,
        columns: host.renderState.columns,
        gap: host.renderState.gap,
      },
      components: host.renderState.components,
    });
  }
};
