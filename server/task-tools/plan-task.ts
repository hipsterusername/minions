/**
 * plan_task tool — Register a task without starting it.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { textResult } from "../harness/tool-result.ts";
import type { TaskToolContext, TaskRecord } from "./types.ts";
import { emitTaskPlanUpdate } from "./shared.ts";

const planTaskInputSchema = z.object({
  taskId: z.string().describe("Unique identifier for this task"),
  title: z.string().describe("Short title for the task"),
  description: z
    .string()
    .describe("Detailed description of what needs to be done"),
  files: z
    .array(z.string())
    .optional()
    .describe("Paths, globs, symbols, or surfaces this task should read or change."),
  constraints: z
    .array(z.string())
    .optional()
    .describe("Invariants, boundaries, and do-not-touch rules for this task."),
  acceptanceCriteria: z
    .array(z.string())
    .optional()
    .describe("Observable conditions that define done for this task."),
  priority: z
    .enum(["low", "medium", "high", "critical"])
    .describe("Task priority level"),
});

export function createPlanTaskToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "plan_task",
    description:
      "Register a task in the plan without executing it yet. Use this to outline your work upfront. Each task can later be executed by you directly with complete_task, or delegated to a Minion with assign_task.",
    inputSchema: planTaskInputSchema,
    handler: async (input: unknown) => {
      const args = planTaskInputSchema.parse(input);
      const { taskId, title, description, priority } = args;

      if (ctx.taskState.tasks.has(taskId)) {
        return textResult(`Task ${taskId} already exists in the plan.`);
      }

      const record: TaskRecord = {
        taskId,
        title,
        description,
        files: args.files,
        constraints: args.constraints,
        acceptanceCriteria: args.acceptanceCriteria,
        priority,
        executor: "leader",
        minionSessionKey: null,
        leaderSessionKey: ctx.leaderSessionKey,
        status: "planned",
        createdAt: Date.now(),
        completedAt: null,
        result: null,
      };
      ctx.taskState.tasks.set(taskId, record);

      emitTaskPlanUpdate(ctx.bus, ctx.leaderSessionKey, ctx.taskState, ctx.onStateChange);

      // Terse ack — the model already knows the title it sent, and the
      // execute/delegate guidance lives in the tool description.
      return textResult(`Task ${taskId} planned.`);
    },
  };
}
