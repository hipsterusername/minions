import type { AgentToolResult, AgentTypeContext } from "./agents/types.ts";
import type { Bus } from "./bus.ts";
import { createChangeIntentTools } from "./change-intent-tools.ts";
import type { AgentHarness } from "./harness/types.ts";
import type { SessionHost } from "./session-host.ts";

export function assertSafeHarnessMutationMode(host: SessionHost, harness: AgentHarness, bus: Bus,
  inheritsWorktree = false): void {
  // Worktree isolation ON (or inherited from a parent worktree): the
  // contribution/approval lifecycle owns change safety — it tracks mutations
  // inside the worktree and merges them into git deliberately. Nothing to
  // enforce here.
  if (host.worktreeIsolation || inheritsWorktree) return;

  // Worktree isolation OFF = live "direct-to-main" mode. There is no
  // contribution lifecycle to protect: every change applies straight to the
  // working tree. Any harness may therefore run regardless of its mutation-
  // interception capability. We still emit a disclosure event so the effective
  // mutation posture stays observable.
  if (harness.capabilities.mutationInterception === "complete") {
    // A "complete" harness with no canonical work item is a legacy live run.
    // Disclose it as observe-only (the coordinator has no work identity to
    // attach to) rather than claiming enforced safety.
    if (!host.workItemId) bus.emitToSession(host.id, {
      type: "mutation_enforcement_compatibility", sessionKey: host.id,
      harness: harness.name, mode: "live", observeOnly: true,
      reason: "legacy session has no canonical work-item coordination context",
      timestamp: Date.now(),
    });
    return;
  }

  // observe_only | none: live mode applies changes directly to the working
  // tree, so there is no interception to enforce and no reason to block. Emit
  // a fallback disclosure and allow the run to proceed.
  bus.emitToSession(host.id, { type: "mutation_enforcement_fallback",
    sessionKey: host.id, harness: harness.name, mode: "live",
    reason: "live mutation interception is unavailable; changes apply directly to the working tree",
    timestamp: Date.now() });
}

export function installChangeIntentTools(context: AgentTypeContext, result: AgentToolResult): void {
  if (context.mutationCoordination) result.toolGroups["change-intent"] =
    createChangeIntentTools(context.mutationCoordination);
}
