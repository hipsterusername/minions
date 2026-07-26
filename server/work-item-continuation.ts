import type Database from "better-sqlite3";
import { executeWorkItemCommand } from "./work-item-command-ledger.ts";
import { getWorkItem, getWorkItemRun, WorkItemConflictError } from "./work-item-repo.ts";
import type { WorkItemInvocation } from "./work-item-service-sqlite.ts";
import type { SqliteWorkItemService } from "./work-item-service-sqlite.ts";
import type { SessionHost, SessionHostDeps } from "./session-host.ts";
import type { WorkItemService } from "./work-item-service.ts";
import { WorkItemServiceError } from "./work-item-service.ts";
import { recoverOrphanedWorkItemRun } from "./work-item-run-repair.ts";

export interface RunContinuationInput {
  requestId: string;
  workItemId: string;
  runKey: string;
  prompt: string;
}

export async function continueWorkItemIntent(
  service: SqliteWorkItemService,
  input: Parameters<WorkItemService["continue"]>[0],
) {
  try {
    const detail = service.latestOrThrow(input.workItemId);
    const item = detail.workItem;
    if (item.lifecycle.lifecycleRevision !== input.expectedLifecycleRevision
      || item.currentRunKey !== input.expectedCurrentRunKey) {
      throw new WorkItemServiceError("conflict", "stale work-item lifecycle", detail);
    }
    if (item.lifecycle.runtimeState === "waiting" && item.currentRunKey) {
      return service.replyToWaitingRun({
        requestId: input.requestId, workItemId: input.workItemId,
        runKey: item.currentRunKey, prompt: input.prompt,
        expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
        expectedCurrentRunKey: item.currentRunKey,
      });
    }
    if (item.lifecycle.runtimeState === "starting" || item.lifecycle.runtimeState === "working") {
      if (!item.currentRunKey) {
        throw new WorkItemServiceError("invalid_transition",
          "Active work item has no current run", detail);
      }
      if (service.options.isRunLive?.(item.currentRunKey)) {
        const queued = executeWorkItemCommand(service.options.db, {
          requestId: input.requestId, workItemId: input.workItemId,
          command: "queue_guidance", payload: {
            workItemId: input.workItemId, runKey: item.currentRunKey, prompt: input.prompt,
          }, resultKey: item.currentRunKey, at: service.now(),
        }, () => item.currentRunKey!);
        if (!queued.idempotent) await service.options.queueRunGuidance?.({
          requestId: input.requestId, workItemId: input.workItemId,
          runKey: item.currentRunKey, prompt: input.prompt,
        });
        service.emit(detail, queued.idempotent ? "guidance_replayed" : "guidance_queued", service.now());
        return detail;
      }
      if (!recoverOrphanedWorkItemRun(service.options.db, item.id, item.currentRunKey, service.now())) {
        throw new WorkItemServiceError("conflict",
          "Work-item run changed while reconciling an orphan", service.latestOrThrow(item.id));
      }
      service.emit(service.latestOrThrow(item.id), "orphan_reconciled", service.now());
    }
    const latest = service.latestOrThrow(input.workItemId);
    return service.startRun({ ...input,
      expectedLifecycleRevision: latest.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: latest.workItem.currentRunKey });
  } catch (error) { return service.translate(error, input.workItemId); }
}

const queuedGuidance = new WeakMap<SessionHost, Array<() => void | Promise<void>>>();

/** Queue user guidance received while a provider turn is still in flight. */
export function queueWorkItemGuidance(
  host: SessionHost,
  continuation: () => void | Promise<void>,
): void {
  const queue = queuedGuidance.get(host) ?? [];
  queue.push(continuation);
  queuedGuidance.set(host, queue);
}

/** Re-enter the authoritative continuation router after the current turn settles. */
export function drainQueuedWorkItemGuidance(
  host: SessionHost,
  _deps: SessionHostDeps,
): boolean {
  if (host.status === "running") return false;
  const queue = queuedGuidance.get(host);
  const continuation = queue?.shift();
  if (!continuation) return false;
  if (queue!.length === 0) queuedGuidance.delete(host);
  void Promise.resolve(continuation());
  return true;
}

export async function continueChildWorkItemRun(options: {
  db: Database.Database;
  now: () => number;
  continueRun: (input: WorkItemInvocation & { requestId: string }) => void | Promise<void>;
}, input: RunContinuationInput): Promise<void> {
  executeWorkItemCommand(options.db, { requestId: input.requestId,
    workItemId: input.workItemId, command: "continue_child", payload: input,
    at: options.now() }, () => {
    const run = getWorkItemRun(options.db, input.runKey);
    if (!run || run.work_item_id !== input.workItemId || run.run_kind !== "child") {
      throw new WorkItemConflictError("child run does not belong to work item",
        getWorkItem(options.db, input.workItemId));
    }
    return run.session_key;
  });
  const run = getWorkItemRun(options.db, input.runKey);
  if (!run || run.ended_at !== null) return;
  await options.continueRun({ ...input, invocationKind: "resume_open_run",
    ...(run.session_id ? { resumeId: run.session_id } : {}) });
}
