/**
 * set_permission_mode — update the SDK permission mode on the in-flight
 * query and mirror it onto the session struct.
 */

import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const setPermissionMode: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.permissionMode) {
    sendControlError(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, "permissionMode required");
    return;
  }
  if (!host.queryHandle) {
    sendControlError(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, "No active query");
    return;
  }
  host.queryHandle
    .setPermissionMode(cmd.permissionMode as never)
    .then(() => {
      host.permissionMode = cmd.permissionMode!;
      sendControlResponse(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, {
        permissionMode: cmd.permissionMode,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
