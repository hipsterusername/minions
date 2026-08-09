/**
 * theirs_merge — merge with -X theirs. On conflicts, keep the main
 * branch's version of the file. The session's changes lose.
 */

import { getSessionOrError, sendControlError, runMergeFlow } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const theirsMerge: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree) {
    sendControlError(ws, "theirs_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  runMergeFlow(ctx.bus, host, ws, "theirs_merge", cmd, { strategy: "theirs" });
};
