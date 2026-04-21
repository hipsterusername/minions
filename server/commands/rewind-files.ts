/**
 * rewind_files — delegate to the SDK to revert file edits made after a
 * particular user message. Supports `dryRun` for previewing.
 */

import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const rewindFiles: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.userMessageId) {
    sendControlError(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, "userMessageId required");
    return;
  }
  if (!host.queryHandle) {
    sendControlError(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .rewindFiles(cmd.userMessageId, { dryRun: cmd.dryRun })
    .then((result) => {
      sendControlResponse(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, { result });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
