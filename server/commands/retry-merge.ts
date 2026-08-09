/**
 * retry_merge — re-attempt a clean merge after the user has manually
 * resolved conflicts in the worktree (via terminal or editor).
 */

import { getSessionOrError, sendControlError, runMergeFlow } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const retryMerge: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree) {
    sendControlError(ws, "retry_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  runMergeFlow(ctx.bus, host, ws, "retry_merge", cmd);
};
