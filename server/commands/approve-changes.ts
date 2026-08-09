/**
 * approve_changes — merge the worktree and mark the session completed.
 *
 * This is the user-initiated approval path: they clicked "Approve & Merge"
 * in the UI. The session stops running, the worktree is merged + removed,
 * and a session_completed envelope is emitted so the UI can transition.
 */

import { getSessionOrError, sendControlError, runMergeFlow } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const approveChanges: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (host.workItemId) {
    sendControlError(
      ws,
      "approve_changes",
      host.id,
      cmd.requestId,
      "Canonical work-item contributions must use review and the lineage integration queue",
    );
    return;
  }
  if (!host.worktree) {
    sendControlError(ws, "approve_changes", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  runMergeFlow(ctx.bus, host, ws, "approve_changes", cmd);
};
