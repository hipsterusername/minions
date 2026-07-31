import type Database from "better-sqlite3";
import type { Bus } from "./bus.ts";
import type { WorkItemRuntimeLifecycle, WorkItemRuntimeIdentity } from "./session-host-types.ts";
import {
  getWorkItem,
  getWorkItemRun,
  resumeWaitingWorkItemRun,
  WorkItemConflictError,
} from "./work-item-repo.ts";
import type { SqliteWorkItemService } from "./work-item-service-sqlite.ts";
import { emitItemChanged } from "./work-item-service-events.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("work-item-runtime");

export function createWorkItemRuntimeLifecycle(input: {
  db: Database.Database; bus: Bus; service: SqliteWorkItemService;
  collectWorktreeRun?: (runKey: string,
    outcome: "completed" | "error" | "stopped" | "interrupted") => Promise<void>;
}): WorkItemRuntimeLifecycle {
  const latest = (identity: WorkItemRuntimeIdentity) => {
    const item = getWorkItem(input.db, identity.workItemId);
    const run = getWorkItemRun(input.db, identity.runKey);
    if (!item || !run || run.work_item_id !== item.id || run.run_kind !== identity.runKind) {
      throw new WorkItemConflictError("runtime run identity mismatch", item);
    }
    return { item, run };
  };

  const emit = (workItemId: string, cause: string, at: number) => {
    try { const detail = input.service.getSync(workItemId); if (detail) emitItemChanged(input.bus, detail, cause, at); }
    catch (error) { log.warn("publication_failed", { workItemId, cause, error }); }
  };

  return {
    providerInitialized(value) {
      const { run } = latest(value);
      if (run.ended_at !== null) {
        // A provider init can already be queued when an interruption seals the
        // canonical run (notably while a resumed Codex thread is attaching).
        // The terminal row remains immutable; the late observation is stale,
        // not a reason to fail the SessionHost a second time.
        if (run.session_id !== value.providerSessionId) log.warn("stale_provider_init_ignored", {
          workItemId: value.workItemId, runKey: value.runKey,
          providerGeneration: value.providerGeneration,
        });
        return;
      }
      if (!input.service.updateProviderSessionId(value.runKey, value.providerSessionId,
        value.providerGeneration, value.at)) {
        throw new WorkItemConflictError("provider identity update lost race", getWorkItem(input.db, value.workItemId));
      }
    },
    runStarted(value) {
      const current = latest(value);
      let { item } = current;
      const { run } = current;
      if (run.ended_at !== null || value.runKind === "child" || item.runtime_state === "working") return;
      if (item.runtime_state === "waiting") {
        // A checkpoint rollover can open its fresh provider thread at the
        // same idle boundary where wait_and_continue projected `waiting`.
        // There is no command-side resume in that path, so the provider init
        // itself must advance waiting -> starting -> working.
        item = resumeWaitingWorkItemRun(input.db, {
          workItemId: item.id,
          runKey: value.runKey,
          expectedLifecycleRevision: item.lifecycle_revision,
          expectedCurrentRunKey: value.runKey,
          at: value.at,
        }).workItem;
      }
      if (item.runtime_state !== "starting") throw new WorkItemConflictError("run start requires starting item", item);
      const changed = input.db.prepare(`UPDATE work_items SET runtime_state = 'working',
        lifecycle_revision = lifecycle_revision + 1, last_transition_at = ?, updated_at = ?
        WHERE id = ? AND current_run_key = ? AND lifecycle_revision = ? AND runtime_state = 'starting'`)
        .run(value.at, value.at, item.id, value.runKey, item.lifecycle_revision);
      if (changed.changes !== 1) throw new WorkItemConflictError("run start CAS conflict", getWorkItem(input.db, item.id));
      emit(item.id, "runtime_started", value.at);
    },
    runWaiting(value) {
      const { item, run } = latest(value);
      if (run.ended_at !== null || value.runKind === "child") return;
      const waitKind = value.waitKind === "file_conflict" ? "file_conflict"
        : value.waitKind === "decision" || value.waitKind === "blocked" ? "decision" : "other";
      if (item.runtime_state === "waiting" && item.wait_kind === waitKind) return;
      if (item.runtime_state === "waiting") {
        const rank = { other: 1, file_conflict: 2, decision: 3 } as const;
        if (rank[waitKind] <= rank[item.wait_kind ?? "other"]) return;
        const changed = input.db.prepare(`UPDATE work_items SET wait_kind = ?, lifecycle_revision = lifecycle_revision + 1,
          last_transition_at = ?, updated_at = ? WHERE id = ? AND current_run_key = ? AND lifecycle_revision = ? AND runtime_state = 'waiting'`)
          .run(waitKind, value.at, value.at, item.id, value.runKey, item.lifecycle_revision);
        if (changed.changes !== 1) throw new WorkItemConflictError("wait sharpening CAS conflict", getWorkItem(input.db, item.id));
        emit(item.id, "runtime_wait_sharpened", value.at); return;
      }
      if (item.runtime_state !== "working") throw new WorkItemConflictError("run wait requires working item", item);
      try { input.service.markWaiting({ workItemId: item.id, runKey: value.runKey, waitKind,
        expectedLifecycleRevision: item.lifecycle_revision, expectedCurrentRunKey: value.runKey, at: value.at }); }
      catch (error) {
        const after = getWorkItem(input.db, item.id);
        if (after?.runtime_state === "waiting" && after.wait_kind === waitKind)
          log.warn("publication_failed", { workItemId: item.id, cause: "run_waiting", error });
        else throw error;
      }
    },
    runTerminal(value) {
      const { item, run } = latest(value);
      try { if (value.runKind === "child") {
        input.service.sealChildRun({ workItemId: item.id, runKey: value.runKey,
          outcome: value.outcome, finalReportEventId: value.finalReportId,
          finalReport: value.finalReport, at: value.at });
        return;
      }
      input.service.sealPrimaryRun({ workItemId: item.id, runKey: value.runKey,
        outcome: value.outcome, finalReportEventId: value.finalReportId,
        finalReport: value.finalReport, expectedLifecycleRevision: item.lifecycle_revision,
        expectedCurrentRunKey: value.runKey, at: value.at });
      if (item.change_mode === "worktree" && input.collectWorktreeRun) {
        void input.collectWorktreeRun(value.runKey, value.outcome).catch((error) =>
          log.warn("contribution_collection_failed", { workItemId: item.id,
            runKey: value.runKey, error }));
      } }
      catch (error) {
        const after = getWorkItemRun(input.db, value.runKey);
        if (after?.ended_at !== null && after?.run_outcome === value.outcome
          && (value.finalReportId == null || after.final_report_event_id === value.finalReportId)
          && (value.finalReport == null || after.final_report === value.finalReport))
          log.warn("publication_failed", { workItemId: item.id, cause: "run_terminal", error });
        else throw error;
      }
    },
  };
}
