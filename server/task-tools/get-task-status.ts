/**
 * get_task_status tool — Check the status of one or all tasks.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import type {
  RuntimeSessionInfo,
  TaskRecord,
  TaskToolContext,
} from "./types.ts";

type TaskStatusView = TaskRecord & {
  runtimeSessionKey: string | null;
  runtime: RuntimeSessionInfo | null;
};

type TaskStatusSummary = Pick<
  TaskRecord,
  | "taskId"
  | "title"
  | "priority"
  | "status"
  | "executor"
  | "minionSessionKey"
  | "result"
> & {
  runtimeSessionKey: string | null;
  runtime: RuntimeSessionInfo | null;
};

function runtimeSessionKeyForTask(
  ctx: TaskToolContext,
  task: TaskRecord,
): string | null {
  if (task.minionSessionKey) return task.minionSessionKey;
  if (task.executor === "leader" && task.status === "running") {
    return ctx.leaderSessionKey;
  }
  return null;
}

function runtimeForTask(
  ctx: TaskToolContext,
  task: TaskRecord,
): { runtimeSessionKey: string | null; runtime: RuntimeSessionInfo | null } {
  const runtimeSessionKey = runtimeSessionKeyForTask(ctx, task);
  return {
    runtimeSessionKey,
    runtime: runtimeSessionKey
      ? (ctx.getSessionRuntime?.(runtimeSessionKey) ?? null)
      : null,
  };
}

function detailView(ctx: TaskToolContext, task: TaskRecord): TaskStatusView {
  return { ...task, ...runtimeForTask(ctx, task) };
}

function summaryView(ctx: TaskToolContext, task: TaskRecord): TaskStatusSummary {
  return {
    taskId: task.taskId,
    title: task.title,
    priority: task.priority,
    status: task.status,
    executor: task.executor,
    minionSessionKey: task.minionSessionKey,
    result: task.result,
    ...runtimeForTask(ctx, task),
  };
}

export function createGetTaskStatusToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "get_task_status",
    description:
      "Check the status of one or all tasks. Returns current status, executor, runtime session metadata, and any results.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
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
              text: JSON.stringify(detailView(ctx, record), null, 2),
            },
          ],
        };
      }

      // Return all tasks
      const all = Array.from(ctx.taskState.tasks.values()).map((t) =>
        summaryView(ctx, t),
      );

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
