/**
 * set_permission_mode — update the harness permission mode on the in-flight
 * run and mirror it onto the session struct.
 * Requires an active run whose harness supports permission changes.
 */

import {
  getSessionOrError,
  sendControlError,
  sendControlResponse,
  unsupportedByHarness,
  errToMessage,
} from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const setPermissionMode: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!cmd.permissionMode) {
    sendControlError(ws, "set_permission_mode", host.id, cmd.requestId, "permissionMode required");
    return;
  }
  if (!host.runControl) {
    sendControlError(ws, "set_permission_mode", host.id, cmd.requestId, "No active query");
    return;
  }
  const fn = host.runControl.setPermissionMode;
  if (!fn) {
    unsupportedByHarness(ws, "set_permission_mode", host, cmd.requestId);
    return;
  }
  fn.call(host.runControl, cmd.permissionMode)
    .then(() => {
      host.permissionMode = cmd.permissionMode!;
      sendControlResponse(ws, "set_permission_mode", host.id, cmd.requestId, {
        permissionMode: cmd.permissionMode,
      });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "set_permission_mode", host.id, cmd.requestId, errToMessage(err));
    });
};
