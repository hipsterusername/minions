/**
 * start_routine — kick off a routine run.
 *
 * Resolves the routine from disk, hands the registry the inputs, and
 * replies with a `routine_started` envelope carrying the freshly minted
 * runId. The registry then drives `routine_progress` events asynchronously
 * as phases progress.
 *
 * Failure modes:
 *   - missing routineId or cwd → `routine_error`
 *   - routine file missing or invalid → `routine_error` with a reason
 *   - inputs validation throws inside the scheduler → surfaces later as
 *     a `routine_progress` snapshot with state="error".
 */

import { unicastGlobal } from "../bus.ts";
import { validateSessionCwd } from "../path-guard.ts";
import type { CommandHandler } from "./types.ts";

export const startRoutine: CommandHandler = (ctx, cmd, ws) => {
  const requestId = cmd.requestId ?? null;
  if (!cmd.routineId) {
    unicastGlobal(ws, {
      type: "routine_error",
      requestId,
      error: "start_routine requires `routineId`.",
    });
    return;
  }
  const rawCwd = cmd.cwd ?? process.cwd();
  const cwd = validateSessionCwd(rawCwd);
  if (!cwd) {
    unicastGlobal(ws, {
      type: "routine_error",
      requestId,
      error: "Invalid cwd: must be under home directory.",
    });
    return;
  }
  const result = ctx.routines.startById({
    projectPath: cwd,
    cwd,
    routineId: cmd.routineId,
    inputs: cmd.routineInputs ?? {},
    ...(cmd.runId ? { runId: cmd.runId } : {}),
  });
  if ("error" in result) {
    unicastGlobal(ws, {
      type: "routine_error",
      requestId,
      error: result.error,
    });
    return;
  }
  unicastGlobal(ws, {
    type: "routine_started",
    requestId,
    runId: result.runId,
    routineId: cmd.routineId,
  });
};
