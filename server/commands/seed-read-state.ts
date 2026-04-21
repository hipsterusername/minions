/**
 * seed_read_state — tell the SDK that a file has already been "Read"
 * (with a given mtime) so subsequent Edit calls pass the safety check.
 */

import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const seedReadState: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.path || cmd.mtime === undefined) {
    sendControlError(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId, "path and mtime required");
    return;
  }
  if (!host.queryHandle) {
    sendControlError(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .seedReadState(cmd.path, cmd.mtime)
    .then(() => {
      sendControlResponse(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId);
    })
    .catch((err: unknown) => {
      sendControlError(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
