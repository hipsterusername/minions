/**
 * stop_session — abort the SDK query and mark the session stopped.
 *
 * Cancels any active wait_and_continue timer first so the session doesn't
 * resume after the user explicitly stopped it.
 */

import type { BusPayload } from "../bus.ts";
import type { BufferedEvent } from "../session-host.ts";
import type { CommandHandler } from "./types.ts";

export const stopSession: CommandHandler = (ctx, cmd) => {
  if (!cmd.sessionKey) return;
  const host = ctx.registry.get(cmd.sessionKey);
  if (!host) return;

  if (host.waitTimerId) {
    host.clearWaitTimer();
    ctx.bus.emitToSession(cmd.sessionKey, {
      type: "wait_state",
      sessionKey: cmd.sessionKey,
      action: "cancelled",
      reason: "Session stopped",
      timestamp: Date.now(),
    });
  }
  host.abortController.abort();
  host.status = "stopped";
  const stopEvent: BufferedEvent = {
    type: "session_status",
    sessionKey: cmd.sessionKey,
    status: "stopped",
    timestamp: Date.now(),
  };
  host.bufferEvent(stopEvent);
  ctx.bus.emitToSession(cmd.sessionKey, stopEvent as BusPayload);
};
