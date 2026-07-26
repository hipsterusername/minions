import type { WorkItemDetailSnapshot } from "../shared/work-item-contracts.ts";

export const MAX_PROMPT_ATTEMPTS = 3;

export type PromptWorkItemCommand = {
  type: "start_work_item_run" | "reply_to_waiting_run";
  requestId: string;
  workItemId: string;
  prompt: string;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string | null;
  runKey?: string;
  [key: string]: unknown;
};

export type ConflictRecoveryGiveUpReason =
  | "non-conflict"
  | "missing-latest"
  | "identity-mismatch"
  | "attempts-exhausted"
  | "unsupported-state";

export type ConflictRecoveryDecision =
  | { kind: "retry"; command: PromptWorkItemCommand }
  | { kind: "converge" }
  | { kind: "give-up"; reason: ConflictRecoveryGiveUpReason };

export interface ConflictRecoveryInput {
  code: string | null | undefined;
  latest: WorkItemDetailSnapshot | null | undefined;
  /** One-based count including the command that just failed. */
  attempt: number;
  projectId: string | null;
  workItemId: string;
  prompt: string;
  /** Fresh request identity for a possible retry. */
  requestId: string;
  options?: Readonly<Record<string, unknown>>;
}

/**
 * The cross-surface policy for prompt-bearing work-item conflicts.
 * It is intentionally pure: callers provide the fresh request id and perform
 * the resulting send, snapshot publication, convergence, or failure UX.
 */
export function decideConflictRecovery(
  input: ConflictRecoveryInput,
): ConflictRecoveryDecision {
  if (input.code !== "conflict") return { kind: "give-up", reason: "non-conflict" };
  const item = input.latest?.workItem;
  if (!item) return { kind: "give-up", reason: "missing-latest" };
  if (item.id !== input.workItemId || item.projectId !== input.projectId) {
    return { kind: "give-up", reason: "identity-mismatch" };
  }
  if (item.lifecycle.runtimeState === "starting"
    || item.lifecycle.runtimeState === "working") {
    return { kind: "converge" };
  }
  if (input.attempt >= MAX_PROMPT_ATTEMPTS) {
    return { kind: "give-up", reason: "attempts-exhausted" };
  }

  const replying = item.lifecycle.runtimeState === "waiting"
    && item.waitKind === "decision" && item.currentRunKey !== null;
  if (item.lifecycle.runtimeState !== "draft"
    && item.lifecycle.runtimeState !== "inactive" && !replying) {
    return { kind: "give-up", reason: "unsupported-state" };
  }

  return {
    kind: "retry",
    command: {
      ...input.options,
      type: replying ? "reply_to_waiting_run" : "start_work_item_run",
      requestId: input.requestId,
      workItemId: item.id,
      ...(replying ? { runKey: item.currentRunKey! } : {}),
      prompt: input.prompt,
      expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
      expectedCurrentRunKey: item.currentRunKey,
    },
  };
}
