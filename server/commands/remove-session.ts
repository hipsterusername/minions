/**
 * remove_session — tear down a session completely. Cancels the run,
 * removes the worktree if present, drops the row from SQLite, and
 * broadcasts an updated session list.
 * close() is fire-and-forget if present; absence is silently ignored — this
 * is a teardown path, not a user-facing feature gate.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import { removeWorktree } from "../worktree.ts";
import { removePersistedSession } from "../session-persist.ts";
import { deleteHtmlArtifactsForSession } from "../html-artifact-store.ts";
import { serverLogger } from "../logging.ts";
import type { CommandHandler } from "./types.ts";

const log = serverLogger.child("remove-session");

export const removeSession: CommandHandler = (ctx, cmd, ws) => {
  if (!cmd.sessionKey) {
    unicastGlobal(ws, { type: "error", message: "sessionKey required" });
    return;
  }
  const host = ctx.registry.get(cmd.sessionKey);
  if (host) {
    if (host.workItemId) {
      unicastToSession(ws, cmd.sessionKey, {
        type: "session_error", sessionKey: cmd.sessionKey,
        error: "Canonical work-item runs cannot be removed directly",
        code: "WORK_ITEM_SESSION_PROTECTED", workItemId: host.workItemId,
        guidance: "Archive the work item or start a new work-item iteration.", timestamp: Date.now(),
      });
      return;
    }
    host.markRemoved();
    void host.terminate("remove", {
      bus: ctx.bus,
      forEachLeaderTaskState: ctx.registry.forEachLeaderTaskState,
    }).catch((error: unknown) => log.warn("session_remove_shutdown_failed", { sessionKey: host.id, error }));

    if (host.worktree) {
      const { path: wtPath, projectPath: wtProject } = host.worktree;
      removeWorktree(wtPath, wtProject).catch((err: unknown) => {
        log.warn("worktree_cleanup_failed", {
          sessionKey: cmd.sessionKey,
          error: err,
        });
      });
      host.worktree = null;
    }

    ctx.registry.delete(cmd.sessionKey);
    removePersistedSession(cmd.sessionKey);
  }

  // Delete any temporary HTML visualization artifacts for this session. These
  // live outside the worktree and DB, so they are cleaned up explicitly here
  // (and swept on startup if a session ever dies without this path running).
  deleteHtmlArtifactsForSession(cmd.sessionKey).catch((err: unknown) => {
    log.warn("artifact_cleanup_failed", {
      sessionKey: cmd.sessionKey,
      error: err,
    });
  });

  ctx.bus.emitGlobal({ type: "session_list", sessions: ctx.registry.snapshot() });
};
