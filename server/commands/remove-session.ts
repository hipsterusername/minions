/**
 * remove_session — tear down a session completely. Cancels the query,
 * removes the worktree if present, drops the row from SQLite, and
 * broadcasts an updated session list.
 */

import { unicastGlobal } from "../bus.ts";
import { removeWorktree } from "../worktree.ts";
import { removePersistedSession } from "../session-persist.ts";
import { errToMessage } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

export const removeSession: CommandHandler = (ctx, cmd, ws) => {
  if (!cmd.sessionKey) {
    unicastGlobal(ws, { type: "error", message: "sessionKey required" });
    return;
  }
  const host = ctx.registry.get(cmd.sessionKey);
  if (host) {
    host.clearWaitTimer();
    if (host.queryHandle) host.queryHandle.close();
    host.abortController.abort();

    if (host.worktree) {
      const { path: wtPath, projectPath: wtProject } = host.worktree;
      removeWorktree(wtPath, wtProject).catch((err: unknown) => {
        console.warn(
          `[worktree] Cleanup on remove_session failed for ${cmd.sessionKey}: ${errToMessage(err)}`,
        );
      });
      host.worktree = null;
    }

    ctx.registry.delete(cmd.sessionKey);
    removePersistedSession(cmd.sessionKey);
  }
  ctx.bus.emitGlobal({ type: "session_list", sessions: ctx.registry.snapshot() });
};
