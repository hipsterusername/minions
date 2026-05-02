/**
 * get_task_status tool — Check the status of one or all tasks.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import type { TaskToolContext } from "./types.ts";

export function createGetTaskStatusToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "get_task_status",
    description:
      "Check the status of one or all tasks. Returns current status, executor, and any results.",
    inputSchema: z.object({
      taskId: z
        .string()
        .optional()
        .describe(
          "Specific task ID to check. If omitted, returns status of all tasks.",
        ),
    }),
    handler: async (input: unknown) => {
      const args = input as { taskId?: string };
      if (args.taskId) {
        const record = ctx.taskState.tasks.get(args.taskId);
        if (!record) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task ${args.taskId} not found.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(record, null, 2),
            },
          ],
        };
      }

      // Return all tasks
      const all = Array.from(ctx.taskState.tasks.values()).map((t) => ({
        taskId: t.taskId,
        title: t.title,
        priority: t.priority,
        status: t.status,
        executor: t.executor,
        minionSessionKey: t.minionSessionKey,
        result: t.result,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              all.length === 0
                ? "No tasks in plan yet."
                : JSON.stringify(all, null, 2),
          },
        ],
      };
    },
  };
}
