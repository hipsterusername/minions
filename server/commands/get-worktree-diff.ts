/**
 * get_worktree_diff — inspect isolated changes against the base branch, or
 * current shared workspace changes for live sessions. This grants no approval.
 */

import { getDetailedDiff } from "../worktree.ts";
import { getWorkspaceDiff } from "../workspace-diff.ts";
import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const getWorktreeDiff: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree && host.worktreeIsolation) {
    sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  (host.worktree ? getDetailedDiff(host.worktree) : getWorkspaceDiff(host.cwd))
    .then((diff) => {
      sendControlResponse(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, { diff });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
