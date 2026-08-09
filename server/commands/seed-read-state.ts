/**
 * seed_read_state — tell the harness that a file has already been "Read"
 * (with a given mtime) so subsequent Edit calls pass the safety check.
 * Requires an active run whose harness supports read-state seeding.
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const seedReadState: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.path || cmd.mtime === undefined) {
    sendControlError(ws, "seed_read_state", host.id, cmd.requestId, "path and mtime required");
    return;
  }
  if (!host.runControl) {
    sendControlError(ws, "seed_read_state", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.seedReadState;
  if (!fn) {
    unsupportedByHarness(ws, "seed_read_state", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, { path: cmd.path, mtime: cmd.mtime })
    .then(() => {
      sendControlResponse(ws, "seed_read_state", host.id, cmd.requestId);
    })
    .catch((err: unknown) => {
      sendControlError(ws, "seed_read_state", host.id, cmd.requestId, errToMessage(err));
    });
};
