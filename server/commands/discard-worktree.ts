/**
 * discard_worktree — throw away the worktree branch without merging.
 * Clears any pending approval state and leaves the session idle; a
 * follow-up send_message will lazily create a fresh worktree.
 */

import { removeWorktree } from "../worktree.ts";
import { getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const discardWorktree: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree) {
    sendControlError(ws, "discard_worktree", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  const { path: worktreePath, projectPath: worktreeProject } = host.worktree;
  if (host.taskState?.approval) host.taskState.approval = null;

  removeWorktree(worktreePath, worktreeProject)
    .then(() => {
      host.worktree = null;
      host.cwd = worktreeProject;
      ctx.bus.emitToSession(cmd.sessionKey!, {
        type: "worktree_removed",
        sessionKey: cmd.sessionKey,
        timestamp: Date.now(),
      });
      ctx.bus.emitToSession(cmd.sessionKey!, {
        type: "approval_resolved",
        sessionKey: cmd.sessionKey,
        action: "discarded",
        timestamp: Date.now(),
      });
      sendControlResponse(ws, "discard_worktree", cmd.sessionKey!, cmd.requestId);
    })
    .catch((err: unknown) => {
      sendControlError(ws, "discard_worktree", cmd.sessionKey!, cmd.requestId, errToMessage(err));
    });
};
