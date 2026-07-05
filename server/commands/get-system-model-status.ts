import { getSessionOrError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";
import {
  resolveSystemModelRuntimeForSession,
  systemModelStatus,
} from "../system-model/runtime.ts";

export const getSystemModelStatus: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const runtime = resolveSystemModelRuntimeForSession({
    cwd: host.cwd,
    projectPath: host.worktree?.projectPath ?? host.cwd,
    sessionKey: host.id,
    bus: ctx.bus,
  });
  sendControlResponse(ws, "get_system_model_status", host.id, cmd.requestId, {
    status: systemModelStatus(runtime),
  });
};
