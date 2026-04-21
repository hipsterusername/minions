/**
 * merge_worktree — merge the session's worktree into its project branch
 * and clean it up. Unlike approve_changes this does NOT mark the session
 * completed; the session stays alive so the user can continue working.
 */

import { mergeAndCleanup } from "../worktree.ts";
import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const mergeWorktree: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree) {
    sendControlError(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  const projectPath = host.worktree.projectPath;
  mergeAndCleanup(host.worktree)
    .then((result) => {
      if (result.success) {
        host.worktree = null;
        host.cwd = projectPath;
        ctx.bus.emitToSession(cmd.sessionKey!, {
          type: "worktree_merged",
          sessionKey: cmd.sessionKey,
          result,
          cleaned: true,
          timestamp: Date.now(),
        });
      } else {
        ctx.bus.emitToSession(cmd.sessionKey!, {
          type: "worktree_merge_failed",
          sessionKey: cmd.sessionKey,
          result,
          timestamp: Date.now(),
        });
      }
      sendControlResponse(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, { result });
    })
    .catch((err: unknown) => {
      sendControlError(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
