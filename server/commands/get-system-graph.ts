import { getSessionOrError, sendControlResponse } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";
import { systemModelToGraph } from "../system-model/graph.ts";
import { resolveSystemModelRuntimeForSession } from "../system-model/runtime.ts";

export const getSystemGraph: CommandHandler = (ctx, cmd, ws) => {
  const host = getSessionOrError(ctx.registry, cmd.sessionKey, ws);
  if (!host) return;
  const runtime = resolveSystemModelRuntimeForSession({
    cwd: host.cwd,
    projectPath: host.worktree?.projectPath ?? host.cwd,
    sessionKey: host.id,
    bus: ctx.bus,
  });
  sendControlResponse(ws, "get_system_graph", host.id, cmd.requestId, {
    graph: runtime.model ? systemModelToGraph(runtime.model) : { nodes: [], edges: [] },
    loadErrors: runtime.loadErrors,
  });
};
