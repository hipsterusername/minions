/**
 * abort_routine — cancel an in-flight run.
 *
 * Best-effort: the scheduler doesn't support mid-phase preemption, but
 * the registry will (a) interrupt every leader session currently in
 * flight and (b) flip the run snapshot to state="aborted" so subsequent
 * phases never start.
 */

import { unicastGlobal } from "../bus.ts";
import type { CommandHandler } from "./types.ts";

export const abortRoutine: CommandHandler = (ctx, cmd, ws) => {
  const requestId = cmd.requestId ?? null;
  if (!cmd.runId) {
    unicastGlobal(ws, {
      type: "routine_error",
      requestId,
      error: "abort_routine requires `runId`.",
    });
    return;
  }
  const aborted = ctx.routines.abort(cmd.runId);
  unicastGlobal(ws, {
    type: "routine_aborted",
    requestId,
    runId: cmd.runId,
    accepted: aborted,
  });
};
