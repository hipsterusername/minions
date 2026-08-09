import type Database from "better-sqlite3";
import type { WorkItemDetailSnapshot } from "../shared/work-item-contracts.ts";
import type { ExistingWorkItemMutationContext } from "./work-item-service.ts";
import {
  archiveWorkItem,
  restoreWorkItem,
  reviewWorkItem,
} from "./work-item-repo.ts";
import { executeWorkItemCommand } from "./work-item-command-ledger.ts";

interface ArchivePreparation {
  latest(workItemId: string): WorkItemDetailSnapshot;
  stopRun?(input: { workItemId: string; runKey: string }): void | Promise<void>;
  sealStopped(input: {
    workItemId: string;
    runKey: string;
    expectedLifecycleRevision: number;
    expectedCurrentRunKey: string;
  }): WorkItemDetailSnapshot;
}

type ResolutionKind = "review" | "archive" | "restore";

/**
 * Active dismissal is a two-step durable transition: stop the canonical run,
 * then archive against the post-stop fence. Inactive dismissal retains the
 * caller's original CAS guards.
 */
export async function prepareWorkItemArchive(
  input: ExistingWorkItemMutationContext & { workItemId: string },
  deps: ArchivePreparation,
): Promise<ExistingWorkItemMutationContext & { workItemId: string }> {
  let latest = deps.latest(input.workItemId);
  if (["draft", "inactive"].includes(latest.workItem.lifecycle.runtimeState)) {
    return input;
  }
  const runKey = latest.workItem.currentRunKey;
  if (!runKey) return input;

  await deps.stopRun?.({ workItemId: input.workItemId, runKey });
  latest = deps.latest(input.workItemId);
  if (!["draft", "inactive"].includes(latest.workItem.lifecycle.runtimeState)) {
    latest = deps.sealStopped({
      workItemId: input.workItemId,
      runKey,
      expectedLifecycleRevision: latest.workItem.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: runKey,
    });
  }
  return {
    ...input,
    expectedLifecycleRevision: latest.workItem.lifecycle.lifecycleRevision,
    expectedCurrentRunKey: latest.workItem.currentRunKey,
  };
}

export async function resolveWorkItemMutation(
  input: ExistingWorkItemMutationContext & { workItemId: string },
  kind: ResolutionKind,
  deps: ArchivePreparation & {
    db: Database.Database;
    now(): number;
    emit(detail: WorkItemDetailSnapshot, cause: string, at: number): void;
  },
): Promise<WorkItemDetailSnapshot> {
  const mutationInput = kind === "archive"
    ? await prepareWorkItemArchive(input, deps)
    : input;
  const mutation = kind === "review" ? reviewWorkItem
    : kind === "archive" ? archiveWorkItem : restoreWorkItem;
  const ledger = executeWorkItemCommand(deps.db, {
    requestId: input.requestId,
    workItemId: input.workItemId,
    command: kind,
    payload: input,
    at: deps.now(),
  }, () => mutation(deps.db, {
    workItemId: input.workItemId,
    expectedLifecycleRevision: mutationInput.expectedLifecycleRevision,
    expectedCurrentRunKey: mutationInput.expectedCurrentRunKey,
    at: deps.now(),
  }));
  const detail = deps.latest(input.workItemId);
  deps.emit(detail, ledger.idempotent ? `${kind}_replayed` : kind, deps.now());
  return detail;
}
