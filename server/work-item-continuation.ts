import type Database from "better-sqlite3";
import { executeWorkItemCommand } from "./work-item-command-ledger.ts";
import { getWorkItem, getWorkItemRun, WorkItemConflictError } from "./work-item-repo.ts";
import type { WorkItemInvocation } from "./work-item-service-sqlite.ts";

export interface RunContinuationInput {
  requestId: string;
  workItemId: string;
  runKey: string;
  prompt: string;
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
