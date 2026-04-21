/**
 * plan_task tool — Register a task without starting it.
 */

import { z } from "zod/v4";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { TaskToolContext, TaskRecord } from "./types.ts";
import { emitTaskPlanUpdate } from "./shared.ts";

export function createPlanTaskTool(ctx: TaskToolContext) {
  return tool(
    "plan_task",
    "Register a task in the plan without executing it yet. Use this to outline your work upfront. Each task can later be executed by you directly with complete_task, or delegated to a Minion with assign_task.",
    {
      taskId: z.string().describe("Unique identifier for this task"),
      title: z.string().describe("Short title for the task"),
      description: z
        .string()
        .describe("Detailed description of what needs to be done"),
      priority: z
        .enum(["low", "medium", "high", "critical"])
        .describe("Task priority level"),
    },
    async (args) => {
      const { taskId, title, description, priority } = args;

      if (ctx.taskState.tasks.has(taskId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} already exists in the plan.`,
            },
          ],
        };
      }

      const record: TaskRecord = {
        taskId,
        title,
        description,
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

      return {
        content: [
          {
            type: "text" as const,
            text: `Task "${title}" (${taskId}) added to plan. Execute it yourself with complete_task, or delegate with assign_task.`,
          },
        ],
      };
    },
  );
}
