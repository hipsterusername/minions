import type { AgentToolResult, AgentTypeContext } from "./agents/types.ts";
import type { Bus } from "./bus.ts";
import { createChangeIntentTools } from "./change-intent-tools.ts";
import type { AgentHarness } from "./harness/types.ts";
import type { SessionHost } from "./session-host.ts";

export function assertSafeHarnessMutationMode(host: SessionHost, harness: AgentHarness, bus: Bus,
  inheritsWorktree = false): void {
  if (host.worktreeIsolation || inheritsWorktree) return;
  if (harness.capabilities.mutationInterception === "complete") {
    // Phase 5 removal gate: once every launch is durably work-item-bound,
    // delete this compatibility branch and reject any remaining legacy live
    // launch. Observe-only is disclosure, never an enforced-safety claim.
    // Legacy sessions have no durable work identity through which to attach
    // the coordinator. Preserve compatibility, but advertise observe-only
    // truthfully until they are migrated/backfilled.
    if (!host.workItemId) bus.emitToSession(host.id, {
      type: "mutation_enforcement_compatibility", sessionKey: host.id,
      harness: harness.name, mode: "live", observeOnly: true,
      reason: "legacy session has no canonical work-item coordination context",
      timestamp: Date.now(),
    });
    return;
  }
  bus.emitToSession(host.id, { type: "mutation_enforcement_fallback",
    sessionKey: host.id, harness: harness.name, mode: "worktree",
    reason: "live mutation interception is unavailable", timestamp: Date.now() });
  if (!host.workItemId) throw new Error(`Harness "${harness.name}" cannot safely run a legacy live session; relaunch with worktree isolation`);
  throw new Error(`Harness "${harness.name}" cannot enforce live mutations; start this work item in worktree mode`);
}

export function installChangeIntentTools(context: AgentTypeContext, result: AgentToolResult): void {
  if (context.mutationCoordination) result.toolGroups["change-intent"] =
    createChangeIntentTools(context.mutationCoordination);
}
