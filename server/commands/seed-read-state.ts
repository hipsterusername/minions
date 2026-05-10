/**
 * seed_read_state — tell the harness that a file has already been "Read"
 * (with a given mtime) so subsequent Edit calls pass the safety check.
 *
 * Phase A: migrated from queryHandle to runControl, with the two-step check:
 * (1) no active run → "No active query", (2) method absent → unsupported.
 * Call signature updated to match HarnessRunControl.seedReadState() — args
 * are passed as a single object `{ path, mtime }`.
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
