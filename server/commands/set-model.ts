/**
 * set_model — swap the SDK model mid-run and mirror it onto the host.
 */

import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const setModel: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.queryHandle) {
    sendControlError(ws, "set_model", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .setModel(cmd.model)
    .then(() => {
      host.model = cmd.model ?? null;
      sendControlResponse(ws, "set_model", cmd.sessionKey!, cmd.requestId, {
        model: cmd.model,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "set_model", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
