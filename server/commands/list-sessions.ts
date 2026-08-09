/**
 * list_sessions — broadcast the registry snapshot to the requesting client.
 */

import { unicastGlobal } from "../bus.ts";
import type { CommandHandler } from "./types.ts";

export const listSessions: CommandHandler = (ctx, _cmd, ws) => {
  unicastGlobal(ws, {
    type: "session_list",
    sessions: ctx.registry.snapshot(),
  });
};
