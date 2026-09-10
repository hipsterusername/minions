import type { SqliteWorkItemService } from "./work-item-service-sqlite.ts";
import type { RunContinuationInput } from "./work-item-continuation.ts";
import { getWorkItem, getWorkItemRun, resumeWaitingWorkItemRun } from "./work-item-repo.ts";
import { executeWorkItemCommand } from "./work-item-command-ledger.ts";
import { primaryWakeEligibility, WakeDeliveryError, wakeFailureDisposition } from "./wake-delivery-store.ts";

/** Claim before calling any asynchronous provider adapter. An uncertain claim is
 * never replayed after restart: operator attention is safer than duplicate work. */
export async function resumePrimaryWake(service: SqliteWorkItemService, input: RunContinuationInput) {
  const { db } = service.options;
  db.exec(`CREATE TABLE IF NOT EXISTS wake_dispatch_receipts (
    request_id TEXT PRIMARY KEY, run_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
    state TEXT NOT NULL, generation INTEGER NOT NULL)`);
  const claimed = db.transaction(() => {
    if (primaryWakeEligibility(db, input.workItemId, input.runKey) === "obsolete") {
      throw new WakeDeliveryError("obsolete", "Wake run is no longer the current open primary");
    }
    const receipt = db.prepare(`SELECT run_key,state FROM wake_dispatch_receipts WHERE request_id=?`)
      .get(input.requestId) as { run_key: string; state: string } | undefined;
    if (receipt && receipt.run_key !== input.runKey) throw new WakeDeliveryError("obsolete", "Wake ownership mismatch");
    if (receipt?.state === "delivered") return false;
    if (receipt?.state === "dispatching") throw new WakeDeliveryError("unknown", "Wake dispatch acknowledgement is uncertain; explicit reconciliation required");
    if (service.options.isRunLive?.(input.runKey)) throw new WakeDeliveryError("transient", "Current run is busy");
    executeWorkItemCommand(db, { requestId: input.requestId, command: "wake_resume",
      workItemId: input.workItemId, payload: { workItemId: input.workItemId, runKey: input.runKey }, at: service.now() }, () => {
      const item = getWorkItem(db, input.workItemId)!;
      if (item.runtime_state !== "waiting") throw new WakeDeliveryError("transient", "Current run is not waiting yet");
      return resumeWaitingWorkItemRun(db, { workItemId: input.workItemId, runKey: input.runKey,
        expectedCurrentRunKey: input.runKey, expectedLifecycleRevision: item.lifecycle_revision, at: service.now() });
    });
    const prior = db.prepare("SELECT COALESCE(MAX(provider_generation),0) AS generation FROM run_invocations WHERE run_key=?")
      .get(input.runKey) as { generation: number };
    db.prepare(`INSERT INTO wake_dispatch_receipts(request_id,run_key,state,generation) VALUES (?,?,'dispatching',?)
      ON CONFLICT(request_id) DO UPDATE SET state='dispatching',generation=excluded.generation`)
      .run(input.requestId, input.runKey, prior.generation);
    return true;
  }).immediate();
  if (!claimed) return service.latestOrThrow(input.workItemId);
  try {
    const run = getWorkItemRun(db, input.runKey)!;
    await (service.options.ensureRunContinued ?? service.options.continueRun)({ ...input,
      invocationKind: "resume_open_run", ...(run.session_id ? { resumeId: run.session_id } : {}) });
    db.prepare(`UPDATE wake_dispatch_receipts SET state='delivered' WHERE request_id=?`).run(input.requestId);
  } catch (error) {
    // Only retry a positively transient pre-dispatch failure. Once an invocation
    // exists, even a missing acknowledgement must not start another turn.
    const receipt = db.prepare(`SELECT generation FROM wake_dispatch_receipts WHERE request_id=?`)
      .get(input.requestId) as { generation: number } | undefined;
    if (!receipt) throw new WakeDeliveryError("obsolete", "Wake run was removed during dispatch");
    const invocation = db.prepare(`SELECT 1 FROM run_invocations WHERE run_key=? AND provider_generation>? LIMIT 1`)
      .get(input.runKey, receipt.generation);
    if (!invocation && !service.options.isRunLive?.(input.runKey) && wakeFailureDisposition(error) === "transient") {
      db.prepare(`UPDATE wake_dispatch_receipts SET state='retry' WHERE request_id=?`).run(input.requestId);
    }
    throw error;
  }
  const detail = service.latestOrThrow(input.workItemId);
  service.emit(detail, "wake_resumed", service.now());
  return detail;
}
