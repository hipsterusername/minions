/**
 * get_task_status tool — Check the status of one or all tasks.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult, textResult } from "../harness/tool-result.ts";
import { isTerminalTaskStatus } from "../task-lifecycle.ts";
import type {
  RuntimeSessionInfo,
  TaskRecord,
  TaskToolContext,
} from "./types.ts";
import {
  capTaskTextForSummary,
  DETAIL_DESCRIPTION_MAX_CHARS,
  DETAIL_RESULT_MAX_CHARS,
} from "./result-summary.ts";

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

type TaskStatusDetailMode = "summary" | "full";

const SUMMARY_RESULT_MAX = 200;
const TRUNCATION_SUFFIX = "… [truncated — fetch taskId for full text]";

function truncateResult(result: string | null): string | null {
  if (result === null || result.length <= SUMMARY_RESULT_MAX) return result;
  return result.slice(0, SUMMARY_RESULT_MAX) + TRUNCATION_SUFFIX;
}

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

function detailView(
  ctx: TaskToolContext,
  task: TaskRecord,
  detail: TaskStatusDetailMode,
): TaskStatusView {
  const view = { ...task, ...runtimeForTask(ctx, task) };
  if (detail === "full") return view;
  return {
    ...view,
    description: capTaskTextForSummary(
      view.description,
      DETAIL_DESCRIPTION_MAX_CHARS,
      "description",
    ),
    result:
      view.result === null
        ? null
        : capTaskTextForSummary(view.result, DETAIL_RESULT_MAX_CHARS, "result"),
  };
}

function summaryView(ctx: TaskToolContext, task: TaskRecord): TaskStatusSummary {
  const terminal = isTerminalTaskStatus(task.status);
  return {
    taskId: task.taskId,
    title: task.title,
    priority: task.priority,
    status: task.status,
    executor: task.executor,
    minionSessionKey: task.minionSessionKey,
    result: truncateResult(task.result),
    ...(terminal
      ? { runtimeSessionKey: null, runtime: null }
      : runtimeForTask(ctx, task)),
  };
}

const getTaskStatusInputSchema = z.object({
  taskId: z
    .string()
    .optional()
    .describe(
      "Specific task ID to check. If omitted, returns status of all tasks.",
    ),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      'Detail mode for taskId lookups. "summary" is the default and caps long description/result fields with a marker; "full" returns the complete stored record.',
    ),
});

export function createGetTaskStatusToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "get_task_status",
    description:
      'Check the status of one or all tasks. All-tasks view stays compact. For taskId detail lookups, detail:"summary" is the default and caps long description/result fields; use detail:"full" to fetch the complete stored text.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    inputSchema: getTaskStatusInputSchema,
    handler: async (input: unknown) => {
      const args = getTaskStatusInputSchema.parse(input);
      if (args.taskId) {
        const record = ctx.taskState.tasks.get(args.taskId);
        if (!record) {
          return textResult(`Task ${args.taskId} not found.`);
        }
        // Compact, null-stripped JSON — pretty-printing roughly doubles the
        // token cost of structured payloads. See harness/tool-result.ts.
        return jsonResult(detailView(ctx, record, args.detail ?? "summary"));
      }

      // Return all tasks
      const all = Array.from(ctx.taskState.tasks.values()).map((t) =>
        summaryView(ctx, t),
      );

      return all.length === 0
        ? textResult("No tasks in plan yet.")
        : jsonResult(all);
    },
  };
}
