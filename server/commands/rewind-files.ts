/**
 * rewind_files — delegate to the harness to revert file edits made after a
 * particular user message. Supports `dryRun` for previewing.
 * Requires an active run whose harness supports file rewind.
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const rewindFiles: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.userMessageId) {
    sendControlError(ws, "rewind_files", host.id, cmd.requestId, "userMessageId required");
    return;
  }
  if (!host.runControl) {
    sendControlError(ws, "rewind_files", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.rewindFiles;
  if (!fn) {
    unsupportedByHarness(ws, "rewind_files", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, { userMessageId: cmd.userMessageId, dryRun: cmd.dryRun })
    .then((result: unknown) => {
      sendControlResponse(ws, "rewind_files", host.id, cmd.requestId, { result });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "rewind_files", host.id, cmd.requestId, errToMessage(err));
    });
};
