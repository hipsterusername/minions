/**
 * stop_session — abort the SDK query and mark the session stopped.
 *
 * Cancels any active wait_and_continue timer first so the session doesn't
 * resume after the user explicitly stopped it.
 */

import type { CommandHandler } from "./types.ts";

export const stopSession: CommandHandler = (ctx, cmd) => {
  if (!cmd.sessionKey) return;
  const host = ctx.registry.get(cmd.sessionKey);
  if (!host) return;

  host.terminate("stop", {
    bus: ctx.bus,
    forEachLeaderTaskState: ctx.registry.forEachLeaderTaskState,
  });
};
