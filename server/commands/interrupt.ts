/**
 * interrupt / interrupt_session — cancel the in-flight SDK turn without
 * stopping the session. Both command names point at the same behaviour.
 *
 * Phase A: migrated from queryHandle.interrupt() to host.runControl.interrupt(),
 * with the two-step check: (1) no active run → "No active query",
 * (2) method absent → "not supported by harness".
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

function makeHandler(command: "interrupt" | "interrupt_session"): CommandHandler {
  return (ctx, cmd, ws) => {
    const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
    if (!host) return;
    if (!host.runControl) {
      sendControlError(ws, command, host.id, cmd.requestId, "No active query");
      return;
    }
    const fn = host.runControl.interrupt;
    if (!fn) {
      unsupportedByHarness(ws, command, host, cmd.requestId);
      return;
    }
    fn.call(host.runControl)
      .then(() => sendControlResponse(ws, command, host.id, cmd.requestId))
      .catch((err: unknown) =>
        sendControlError(ws, command, host.id, cmd.requestId, errToMessage(err)),
      );
  };
}

export const interrupt = makeHandler("interrupt");
export const interruptSession = makeHandler("interrupt_session");
