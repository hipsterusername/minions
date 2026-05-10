/**
 * close_session — close the active harness run but keep the session struct
 * alive for resume. Emits a `session_status: stopped` event.
 *
 * Phase A: migrated from queryHandle to runControl / eventStream.
 * close() is fire-and-forget if present; absence is silently ignored (closing
 * is best-effort — the local state update is unconditional).
 */

import type { BusPayload } from "../bus.ts";
import type { BufferedEvent } from "../session-host.ts";
import { getSessionOrError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const closeSession: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  host.clearWaitTimer();
  // Fire-and-forget; absence of close() is a no-op — do not emit an error.
  void host.runControl?.close?.();
  host.status = "stopped";
  host.eventStream = null;
  host.runControl = null;
  const event: BufferedEvent = {
    type: "session_status",
    sessionKey: cmd.sessionKey!,
    status: "stopped",
    timestamp: Date.now(),
  };
  host.bufferEvent(event);
  ctx.bus.emitToSession(cmd.sessionKey!, event as BusPayload);
  sendControlResponse(ws, "close_session", cmd.sessionKey!, cmd.requestId);
};
