/**
 * stop_task — ask the harness to cancel a subagent Task by id.
 *
 * Phase A: migrated from queryHandle to runControl, with the two-step check:
 * (1) no active run → "No active query", (2) method absent → unsupported.
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const stopTask: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.taskId) {
    sendControlError(ws, "stop_task", host.id, cmd.requestId, "taskId required");
    return;
  }
  if (!host.runControl) {
    sendControlError(ws, "stop_task", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.stopTask;
  if (!fn) {
    unsupportedByHarness(ws, "stop_task", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, cmd.taskId)
    .then(() => {
      sendControlResponse(ws, "stop_task", host.id, cmd.requestId, {
        taskId: cmd.taskId,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "stop_task", host.id, cmd.requestId, errToMessage(err));
    });
};
