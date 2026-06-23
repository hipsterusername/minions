/**
 * complete_task tool — Mark a task as completed by the leader directly.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { errorResult, textResult } from "../harness/tool-result.ts";
import type { TaskToolContext } from "./types.ts";
import { applyLifecycleEvent, isTerminalTaskStatus } from "../task-lifecycle.ts";

const completeTaskInputSchema = z.object({
  taskId: z.string().describe("The task ID to mark as completed"),
  result: z.string().describe("Summary of what was done and the outcome"),
});

export function createCompleteTaskToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "complete_task",
    description:
      "Mark a task as completed by you (the leader) directly. Use this when you have executed a task yourself without delegating to a minion.",
    inputSchema: completeTaskInputSchema,
    handler: async (input: unknown) => {
      const args = completeTaskInputSchema.parse(input);
      const { taskId, result } = args;

      const record = ctx.taskState.tasks.get(taskId);

      if (!record) {
        return errorResult(
          `Task ${taskId} does not exist. Register it with plan_task before completing it.`,
        );
      }

      if (isTerminalTaskStatus(record.status)) {
        return textResult(`Task ${taskId} is already ${record.status}.`);
      }

      applyLifecycleEvent({
        bus: ctx.bus,
        leaderSessionKey: ctx.leaderSessionKey,
        taskState: ctx.taskState,
        taskId,
        event: { type: "leader_completed", result },
        onStateChange: ctx.onStateChange,
      });

      return textResult(`Task ${taskId} completed.`);
    },
  };
}
