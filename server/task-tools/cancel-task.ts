/**
 * cancel_task tool — Leader-driven cancellation of a delegated task.
 *
 * Terminates the live minion session (if any) and transitions the task to
 * the non-absorbing `cancelled` terminal state. Cancelled tasks are
 * retryable via a later assign_task with the same taskId.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { errorResult, textResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";
import { applyLifecycleEvent, isTerminalTaskStatus } from "../task-lifecycle.ts";

const cancelTaskInputSchema = z.object({
  taskId: z.string().describe("The task ID to cancel"),
  reason: z
    .string()
    .describe("Why the task is being cancelled (stored as the task result)"),
});

export function createCancelTaskToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "cancel_task",
    description:
      "Cancel a delegated task. Terminates the live minion session (if any) and marks the task cancelled. Cancelled tasks can be retried later with assign_task using the same taskId.",
    inputSchema: cancelTaskInputSchema,
    handler: async (input: unknown) => {
      const args = cancelTaskInputSchema.parse(input);
      const { taskId, reason } = args;

      const record = ctx.taskState.tasks.get(taskId);

      if (!record) {
        return errorResult(
          `Task ${taskId} does not exist. Nothing to cancel.`,
        );
      }

      if (isTerminalTaskStatus(record.status)) {
        return textResult(
          `Task ${taskId} is already ${record.status} — cannot cancel.`,
        );
      }

      // Fence and persist the attempt before termination can synchronously
      // report a session-ended event back into the lifecycle reducer.
      const minionSessionKey = record.minionSessionKey;

      applyLifecycleEvent({
        bus: ctx.bus,
        leaderSessionKey: ctx.leaderSessionKey,
        taskState: ctx.taskState,
        taskId,
        event: {
          type: "cancelled",
          result: reason,
          attemptId: record.attemptId,
          attemptGeneration: record.attemptGeneration,
        },
        onStateChange: ctx.onStateChange,
      });

      if (minionSessionKey) {
        ctx.terminateSession?.(minionSessionKey, "abort");
      }

      return textResult(`Task ${taskId} cancelled.`);
    },
  };
}
