import type Database from "better-sqlite3";
import { getHarness } from "./harness/index.ts";
import type { NormalizedEvent } from "./harness/types.ts";
import { terminalKind, terminalProvenance } from "./harness/terminal-provenance.ts";
import { persistenceDb } from "./session-persist.ts";
import type { SessionHost } from "./session-host.ts";
import { getWorkItem, startWorkItemIteration, WorkItemConflictError } from "./work-item-repo.ts";
import {
  claimRunInvocationTerminal,
  finalizeRunInvocationTermination,
  markRunInvocationRunning,
  recordRunInvocationIntent,
  startRunInvocation,
  type InvocationTerminationIntent,
} from "./work-item-invocations.ts";
import { kanbanCardMetadataSchema } from "../shared/work-item-kanban.ts";

export function startWorkItemIterationForHarness(db: Database.Database,
  input: Parameters<typeof startWorkItemIteration>[1] & { harness: string }) {
  const row = getWorkItem(db, input.workItemId);
  if (!row) throw new WorkItemConflictError("work item not found", null);
  let interception: "complete" | "observe_only" | "none";
  try { interception = getHarness(input.harness).capabilities.mutationInterception; }
  catch { interception = input.harness === "claude" ? "complete" : "observe_only"; }
  // Canonical live mode is truthful only when the adapter can stop a mutation
  // before it executes. Observe-only and non-mutating/unknown adapters both
  // use the isolated workflow so a later capability change cannot silently
  // turn an unenforced live run into a writer.
  const fallback = interception !== "complete";
  if (fallback && row.change_mode === "live") {
    const card = kanbanCardMetadataSchema.parse(JSON.parse(row.kanban_json));
    const changed = db.prepare(`UPDATE work_items SET change_mode = 'worktree',
      integration_state = 'worktree_unprovisioned', kanban_json = ?,
      workflow_revision = workflow_revision + 1, updated_at = ?
      WHERE id = ? AND lifecycle_revision = ? AND current_run_key IS ?`)
      .run(JSON.stringify({ ...card, worktreeIsolation: true }), input.at,
        row.id, input.expectedLifecycleRevision, input.expectedCurrentRunKey);
    if (changed.changes !== 1) throw new WorkItemConflictError(
      "stale work-item lifecycle while selecting safe change mode", getWorkItem(db, row.id));
  }
  return startWorkItemIteration(db, input);
}

function invocationDb(host: SessionHost): Database.Database | null {
  if (!host.workItemId) return null;
  const db = persistenceDb();
  if (!db) return null;
  if (host.providerInvocationGeneration <= 0) {
    const latest = db.prepare(`SELECT provider_generation FROM run_invocations
      WHERE run_key = ? ORDER BY provider_generation DESC LIMIT 1`)
      .get(host.runKey) as { provider_generation: number } | undefined;
    if (latest) host.providerInvocationGeneration = latest.provider_generation;
  }
  return host.providerInvocationGeneration > 0 ? db : null;
}

/** Durable ordering boundary immediately before `harness.start()`. */
export function persistInvocationBeforeHarnessOpen(
  host: SessionHost,
  at = Date.now(),
): void {
  if (!host.workItemId) return;
  const db = persistenceDb();
  if (!db) return;
  const row = startRunInvocation(db, {
    runKey: host.runKey,
    providerId: host.harnessName,
    startedAt: at,
  });
  host.providerInvocationGeneration = row.provider_generation;
}

export function enrichInvocationProviderIdentity(
  host: SessionHost,
  providerSessionId: string,
): void {
  const db = invocationDb(host);
  if (!db) return;
  markRunInvocationRunning(db, {
    runKey: host.runKey,
    providerGeneration: host.providerInvocationGeneration,
    providerSessionId,
  });
}

/**
 * Persist a normalized terminal witness and, when it wins, apply its current
 * Phase-1 projection in the same transaction.
 */
export function persistInvocationTerminalWitness(
  host: SessionHost,
  event: Extract<NormalizedEvent, { kind: "done" }>,
  at: number,
  applyProjection?: () => void,
): boolean {
  const db = invocationDb(host);
  if (!db) {
    applyProjection?.();
    return true;
  }
  return claimRunInvocationTerminal(db, {
    runKey: host.runKey,
    providerGeneration: host.providerInvocationGeneration,
    terminalKind: terminalKind(event),
    terminalSource: terminalProvenance(event),
    terminalAt: at,
    ...(applyProjection ? { applyProjection } : {}),
  }).claimed;
}

export function persistInvocationTerminationIntent(
  host: SessionHost,
  intent: InvocationTerminationIntent,
): void {
  const db = invocationDb(host);
  if (!db) return;
  recordRunInvocationIntent(db, {
    runKey: host.runKey,
    providerGeneration: host.providerInvocationGeneration,
    intent,
  });
}

/** Preserve Phase-1 sealing even when a provider/adapter witness won the CAS. */
export function finalizeInvocationTermination(
  host: SessionHost,
  at: number,
  applyProjection: () => void,
): void {
  const db = invocationDb(host);
  if (!db) {
    applyProjection();
    return;
  }
  finalizeRunInvocationTermination(db, {
    runKey: host.runKey,
    providerGeneration: host.providerInvocationGeneration,
    terminalAt: at,
    applyProjection,
  });
}
