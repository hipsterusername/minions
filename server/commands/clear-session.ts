/**
 * clear_session — wipe conversation history for an idle session.
 *
 * Clears the in-memory event buffer, purges the on-disk event log, and
 * resets cumulative cost/turn counters. Emits `session_cleared` so the
 * client can drop its message list without a round-trip sync.
 *
 * The command is rejected silently when the session is actively running or
 * being created — clearing a live conversation is undefined behavior.
 */

import { clearSessionEvents } from "../session-persist.ts";
import type { CommandHandler } from "./types.ts";

export const clearSession: CommandHandler = (ctx, cmd) => {
  if (!cmd.sessionKey) return;
  const host = ctx.registry.get(cmd.sessionKey);
  if (!host) return;

  if (host.status === "running") return;

  host.eventBuffer = [];
  host.totalCost = 0;
  host.turns = 0;
  host.persist();

  clearSessionEvents(cmd.sessionKey);

  ctx.bus.emitToSession(cmd.sessionKey, {
    type: "session_cleared",
    sessionKey: cmd.sessionKey,
    timestamp: Date.now(),
  });
};
