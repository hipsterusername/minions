/**
 * force_merge — merge with --force. Used when a plain merge reported
 * conflicts and the user has chosen to overwrite anyway.
 */

import { getSessionOrError, sendControlError, runMergeFlow } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";
import { serverLogger } from "../logging.ts";

const log = serverLogger.child("force-merge");

export const forceMerge: CommandHandler = (ctx, cmd, ws) => {
  log.debug("request_received", { sessionKey: cmd.sessionKey });
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) {
    log.debug("session_missing", { sessionKey: cmd.sessionKey });
    return;
  }
  if (!host.worktree) {
    log.debug("worktree_missing", { sessionKey: cmd.sessionKey });
    sendControlError(ws, "force_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  log.debug("merge_started", {
    sessionKey: cmd.sessionKey,
    branch: host.worktree.branch,
    worktreePath: host.worktree.path,
  });
  runMergeFlow(ctx.bus, host, ws, "force_merge", cmd, { force: true });
};
