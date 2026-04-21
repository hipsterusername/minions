/**
 * interrupt / interrupt_session — cancel the in-flight SDK turn without
 * stopping the session. Both command names point at the same behaviour.
 */

import { runQueryOp } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";

function makeHandler(command: "interrupt" | "interrupt_session"): CommandHandler {
  return (ctx, cmd, ws) => {
    runQueryOp(ctx, cmd, ws, command, (host) =>
      host.queryHandle ? host.queryHandle.interrupt() : null,
    );
  };
}

export const interrupt = makeHandler("interrupt");
export const interruptSession = makeHandler("interrupt_session");
