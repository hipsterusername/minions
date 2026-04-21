/**
 * get_task_status tool — Check the status of one or all tasks.
 */

import { z } from "zod/v4";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { TaskToolContext } from "./types.ts";

export function createGetTaskStatusTool(ctx: TaskToolContext) {
  return tool(
    "get_task_status",
    "Check the status of one or all tasks. Returns current status, executor, and any results.",
    {
      taskId: z
        .string()
        .optional()
        .describe(
          "Specific task ID to check. If omitted, returns status of all tasks.",
        ),
    },
    async (args) => {
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
  );
}
