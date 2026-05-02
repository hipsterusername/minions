/**
 * complete_task tool — Mark a task as completed by the leader directly.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import type { TaskToolContext, TaskRecord } from "./types.ts";
import { emitTaskPlanUpdate } from "./shared.ts";

export function createCompleteTaskToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "complete_task",
    description:
      "Mark a task as completed by you (the leader) directly. Use this when you have executed a task yourself without delegating to a minion.",
    inputSchema: z.object({
      taskId: z.string().describe("The task ID to mark as completed"),
      result: z.string().describe("Summary of what was done and the outcome"),
    }),
    handler: async (input: unknown) => {
      const args = input as { taskId: string; result: string };
      const { taskId, result } = args;

      let record = ctx.taskState.tasks.get(taskId);

      if (!record) {
        // Auto-create if the leader completed something without pre-planning
        record = {
          taskId,
          title: taskId,
          description: "",
          priority: "medium",
          executor: "leader",
          minionSessionKey: null,
          leaderSessionKey: ctx.leaderSessionKey,
          status: "planned",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        } satisfies TaskRecord;
        ctx.taskState.tasks.set(taskId, record);
      }

      if (record.status === "completed" || record.status === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} is already ${record.status}.`,
            },
          ],
        };
      }

      record.executor = "leader";
      record.status = "completed";
      record.completedAt = Date.now();
      record.result = result;

      emitTaskPlanUpdate(ctx.bus, ctx.leaderSessionKey, ctx.taskState, ctx.onStateChange);

      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${taskId} marked as completed by leader.`,
          },
        ],
      };
    },
  };
}
