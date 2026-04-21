/**
 * force_merge — merge with --force. Used when a plain merge reported
 * conflicts and the user has chosen to overwrite anyway.
 */

import { getSessionOrError, sendControlError, runMergeFlow } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const forceMerge: CommandHandler = (ctx, cmd, ws) => {
  console.log(`[worktree] force_merge received for ${cmd.sessionKey}`);
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) {
    console.log("[worktree] force_merge: session not found");
    return;
  }
  if (!host.worktree) {
    console.log("[worktree] force_merge: no worktree on session");
    sendControlError(ws, "force_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  console.log(
    `[worktree] force_merge: starting merge for ${host.worktree.branch} at ${host.worktree.path}`,
  );
  runMergeFlow(ctx.bus, host, ws, "force_merge", cmd, { force: true });
};
