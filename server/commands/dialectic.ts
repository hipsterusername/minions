/**
 * start_dialectic / stop_dialectic — drive a Dialectic node's two-planner
 * dialogue.
 *
 * `cmd.sessionKey` carries the Dialectic node's id (the client derives the
 * planner/coordinator keys from it via `dialecticSessionKeys`). `cmd.prompt`
 * is the topic. All coordinator progress is fanned to the node's coordinator
 * topic through the typed bus — never a direct broadcast.
 *
 * The orchestrator instances live in a module-level map keyed by node id,
 * mirroring how the SessionRegistry owns its own map. A node can only have one
 * live dialectic at a time.
 */

import type { CommandHandler } from "./types.ts";
import { DialecticOrchestrator } from "../dialectic/orchestrator.ts";
import { awaitTurn, cancelTurn } from "../dialectic/turn-bridge.ts";
import {
  DIALECTIC_EVENT_TYPE,
  type DialecticEvent,
  dialecticSessionKeys,
  normalizeDialecticConfig,
} from "../../shared/dialectic.ts";

const orchestrators = new Map<string, DialecticOrchestrator>();

/** Sessions a dialectic may hold live at once: planner A + B + synthesis. */
const DIALECTIC_SESSION_BUDGET = 3;

export const startDialectic: CommandHandler = (ctx, cmd) => {
  const nodeId = cmd.sessionKey;
  const topic = cmd.prompt;
  if (!nodeId || !topic || !topic.trim()) return;

  const keys = dialecticSessionKeys(nodeId);
  const emit = (event: DialecticEvent): void => {
    ctx.bus.emitToSession(keys.coordinator, {
      type: DIALECTIC_EVENT_TYPE,
      sessionKey: keys.coordinator,
      event,
    });
  };
  const workspace = cmd.workspaceId
    ? (ctx.resolveWorkspace ?? (() => null))(cmd.workspaceId)
    : null;
  if (cmd.workspaceId && !workspace) {
    emit({ kind: "run_status", status: "error", error: "Workspace is not registered" });
    return;
  }
  if (workspace && cmd.cwd !== undefined) {
    emit({ kind: "run_status", status: "error",
      error: "Workspace launches cannot include cwd" });
    return;
  }

  const existing = orchestrators.get(nodeId);
  if (existing?.isRunning()) {
    emit({ kind: "run_status", status: "running" });
    return;
  }

  if (ctx.registry.activeCount() + DIALECTIC_SESSION_BUDGET > ctx.maxSessions) {
    emit({
      kind: "run_status",
      status: "error",
      error: `Not enough session capacity to start a dialectic (needs up to ${DIALECTIC_SESSION_BUDGET} sessions).`,
    });
    return;
  }

  const config = normalizeDialecticConfig(cmd.dialecticConfig);
  const cwd = workspace?.sourceRoot ?? cmd.cwd ?? process.cwd();

  const orch = new DialecticOrchestrator(nodeId, cwd, config, {
    startSession: (opts) => ctx.registry.start(opts),
    getRuntime: (key) => ctx.registry.getSessionRuntime(key),
    terminate: (key) =>
      ctx.registry.get(key)?.terminate("stop", {
        bus: ctx.bus,
        forEachLeaderTaskState: ctx.registry.forEachLeaderTaskState,
      }),
    emit,
    awaitTurn,
    cancelTurn,
  });
  orchestrators.set(nodeId, orch);
  void orch.run(topic);
};

export const stopDialectic: CommandHandler = (ctx, cmd) => {
  const nodeId = cmd.sessionKey;
  if (!nodeId) return;
  orchestrators.get(nodeId)?.stop();
};

/** Test seam: drop all orchestrator instances. */
export function __resetDialecticOrchestrators(): void {
  orchestrators.clear();
}
