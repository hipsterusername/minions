/**
 * set_model — swap the harness model mid-run and mirror it onto the host.
 * Requires an active run whose harness supports model switching.
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const setModel: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.runControl) {
    sendControlError(ws, "set_model", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.setModel;
  if (!fn) {
    unsupportedByHarness(ws, "set_model", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, cmd.model as string)
    .then(() => {
      host.model = cmd.model ?? null;
      sendControlResponse(ws, "set_model", host.id, cmd.requestId, {
        model: cmd.model,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "set_model", host.id, cmd.requestId, errToMessage(err));
    });
};
