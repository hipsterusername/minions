/**
 * merge_worktree — merge the session's worktree into its project branch
 * and clean it up. Unlike approve_changes this does NOT mark the session
 * completed; the session stays alive so the user can continue working.
 */

import { mergeAndCleanup } from "../worktree.ts";
import {
  evaluateMergeGates,
  shouldEvaluateMergeGates,
  shouldWarnForMergeGates,
} from "../system-model/gates.ts";
import { blockForMergeGates, getSessionOrError, sendControlError, sendControlResponse, errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const mergeWorktree: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  if (!host.worktree) {
    sendControlError(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
    return;
  }
  const projectPath = host.worktree.projectPath;
  const gateVerdict = shouldEvaluateMergeGates(host) ? evaluateMergeGates(host) : null;
  const merge = gateVerdict
    ? gateVerdict.then((verdict) => {
        if (shouldWarnForMergeGates(verdict)) {
          ctx.bus.emitToSession(host.id, {
            type: "merge_gate_warning",
            sessionKey: host.id,
            verdict,
            timestamp: Date.now(),
          });
        }
        if (blockForMergeGates(ctx.bus, host.id, ws, "merge_worktree", cmd.requestId, verdict)) {
          return null;
        }
        return mergeAndCleanup(host.worktree!);
      })
    : mergeAndCleanup(host.worktree);

  merge
    .then((result) => {
      if (!result) return;
      if (result.success) {
        host.worktree = null;
        host.cwd = projectPath;
        host.persist();
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
