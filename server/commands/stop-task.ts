/**
 * stop_task — ask the SDK to cancel a subagent Task by id.
 */

import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const stopTask: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.taskId) {
    sendControlError(ws, "stop_task", cmd.sessionKey!, cmd.requestId, "taskId required");
    return;
  }
  if (!host.queryHandle) {
    sendControlError(ws, "stop_task", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .stopTask(cmd.taskId)
    .then(() => {
      sendControlResponse(ws, "stop_task", cmd.sessionKey!, cmd.requestId, {
        taskId: cmd.taskId,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "stop_task", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
