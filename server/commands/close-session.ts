/**
 * close_session — close the active harness run but keep the session struct
 * alive for resume. Emits a `session_status: stopped` event.
 * close() is fire-and-forget if present; absence is silently ignored (closing
 * is best-effort — the local state update is unconditional).
 */

import { getSessionOrError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const closeSession: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  host.terminate("close", {
    bus: ctx.bus,
    forEachLeaderTaskState: ctx.registry.forEachLeaderTaskState,
  });
  sendControlResponse(ws, "close_session", cmd.sessionKey!, cmd.requestId);
};
