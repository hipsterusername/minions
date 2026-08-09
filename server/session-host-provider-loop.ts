import type { AgentType, AgentTypeContext } from "./agents/index.ts";
import type { NormalizedEvent } from "./harness/types.ts";
import type { SessionHost } from "./session-host.ts";
import type { SessionHostDeps, StartSessionOptions } from "./session-host-types.ts";
import { commitCheckpointOnInit } from "./session-host-checkpoint.ts";
import {
  buildContextRecoveryStartOptions,
  processNormalizedEvent,
  shouldRecoverFromContextWindow,
} from "./session-host-run.ts";
import { buildPendingCompactionStartOptions } from "./proactive-compaction.ts";
import { normalizedEventEnvelope, sessionHostLogFields } from "./session-host-identity.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("session-host");

/**
 * Consume one provider invocation while preserving the distinction between a
 * provider-thread boundary and the terminal boundary of the canonical run.
 */
export async function consumeProviderInvocation(input: {
  host: SessionHost;
  opts: StartSessionOptions;
  deps: SessionHostDeps;
  agentType: AgentType;
  agentCtx: AgentTypeContext;
  events: AsyncIterable<NormalizedEvent>;
  abortController: AbortController;
}): Promise<{ continuationOpts: StartSessionOptions | null; checkpointInitialized: boolean }> {
  const { host, opts, deps, agentType, agentCtx, events, abortController } = input;
  let continuationOpts: StartSessionOptions | null = null;
  let checkpointInitialized = false;
  for await (const event of events) {
    if (abortController.signal.aborted) break;
    if (event.kind === "done" && shouldRecoverFromContextWindow(opts, event)) {
      continuationOpts = buildContextRecoveryStartOptions(host, opts, event);
      const recoveryEvent = normalizedEventEnvelope(host, {
        kind: "text",
        role: "assistant",
        text: "The Codex thread exceeded the model context window. Starting a fresh continuation with compacted session state.",
      });
      host.bufferEvent(recoveryEvent);
      deps.bus.emitToSession(host.id, recoveryEvent);
      break;
    }
    if (event.kind === "done") continuationOpts = buildPendingCompactionStartOptions(host, opts);
    if (event.kind === "done" && continuationOpts) {
      recordProviderContinuationBoundary(host, event);
    } else {
      processNormalizedEvent(host, deps.bus, agentType, agentCtx, event, deps.workItemLifecycle);
    }
    checkpointInitialized = commitCheckpointOnInit(host, deps, opts, event) || checkpointInitialized;
    if (continuationOpts) break;
  }
  continuationOpts ??= buildPendingCompactionStartOptions(host, opts);
  return { continuationOpts, checkpointInitialized };
}

function recordProviderContinuationBoundary(
  host: SessionHost,
  event: Extract<NormalizedEvent, { kind: "done" }>,
): void {
  if (event.turns != null) host.turns = event.turns;
  if (event.costUSD != null) host.totalCost = event.costUSD;
  host.persist();
  log.info("provider_invocation_continuing", sessionHostLogFields(host));
}
