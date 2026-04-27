/**
 * list_routines — return every routine in the project's sidecar plus
 * every live + recently-completed run. The browser uses this to power
 * its "Run" buttons and the canvas uses it to bootstrap RoutineNodes
 * after a refresh.
 *
 * The client passes `cwd` (project root) so the handler knows which
 * sidecar to read.
 */

import { unicastGlobal } from "../bus.ts";
import { listRoutines } from "../routine-store.ts";
import type { CommandHandler } from "./types.ts";

export const listRoutinesCommand: CommandHandler = (ctx, cmd, ws) => {
  const projectPath = cmd.cwd ?? process.cwd();
  const stored = listRoutines(projectPath);
  unicastGlobal(ws, {
    type: "routine_list",
    requestId: cmd.requestId ?? null,
    projectPath,
    routines: stored.routines,
    invalid: stored.invalid,
    runs: ctx.routines.list(),
  });
};
