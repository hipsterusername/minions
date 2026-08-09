/**
 * get_worktree_diff — return a detailed diff of the session's worktree
 * against the base branch, for the approval UI to render.
 */

import { getDetailedDiff } from "../worktree.ts";
import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const getWorktreeDiff: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree) {
    sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  getDetailedDiff(host.worktree)
    .then((diff) => {
      sendControlResponse(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, { diff });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
