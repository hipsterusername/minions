/**
 * close_session — close the active SDK query but keep the session struct
 * alive for resume. Emits a `session_status: stopped` event.
 */

import type { BufferedEvent } from "../session-host.ts";
import { getSessionOrError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const closeSession: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  host.clearWaitTimer();
  if (host.queryHandle) host.queryHandle.close();
  host.status = "stopped";
  host.queryHandle = null;
  const event: BufferedEvent = {
    type: "session_status",
    sessionKey: cmd.sessionKey!,
    status: "stopped",
    timestamp: Date.now(),
  };
  host.bufferEvent(event);
  ctx.bus.emitToSession(cmd.sessionKey!, event);
  sendControlResponse(ws, "close_session", cmd.sessionKey!, cmd.requestId);
};
