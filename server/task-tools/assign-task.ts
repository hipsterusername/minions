/**
 * assign_task tool — Delegate a task to a new Minion session.
 */

import { z } from "zod/v4";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { TaskToolContext, TaskRecord } from "./types.ts";
import { emitTaskPlanUpdate } from "./shared.ts";
import { compileSkills, loadSkillsByIds } from "../skills.ts";

export function createAssignTaskTool(ctx: TaskToolContext) {
  return tool(
    "assign_task",
    "Delegate a task to a new Minion agent. Creates a minion session that will execute the task autonomously. If the task was registered with plan_task, it will transition from planned to running. Optionally arm the minion with one or more skills from the project's skill library via `skillIds`.",
    {
      taskId: z.string().describe("Unique identifier for this task (use the same ID as plan_task if pre-planned)"),
      title: z.string().describe("Short title for the task"),
      description: z
        .string()
        .describe(
          "Detailed description with acceptance criteria. Include all necessary context — file paths, function names, expected behavior, constraints.",
        ),
      priority: z
        .enum(["low", "medium", "high", "critical"])
        .describe("Task priority level"),
      skillIds: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of skill IDs from the project's skill library. The compiled skill instructions are appended to the minion's system prompt — use this to arm the minion with focused expertise for the task.",
        ),
      skillValues: z
        .record(z.string(), z.record(z.string(), z.string()))
        .optional()
        .describe(
          "Optional values for skill template variables, shaped as { skillId: { variableName: value } }. Only needed for skills whose templates declare {{placeholders}}.",
        ),
    },
    async (args) => {
      const { taskId, title, description, priority, skillIds, skillValues } =
        args;

      // Check if already running/completed — don't re-assign
      const existing = ctx.taskState.tasks.get(taskId);
      if (existing && existing.status !== "planned") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} is already ${existing.status}. Use get_task_status to check its progress.`,
            },
          ],
        };
      }

      const minionKey = `minion-${Date.now().toString(36)}-${taskId.slice(0, 8)}`;

      if (existing) {
        // Transition pre-planned task to running
        existing.executor = "minion";
        existing.minionSessionKey = minionKey;
        existing.status = "running";
      } else {
        // Create and immediately delegate
        const record: TaskRecord = {
          taskId,
          title,
          description,
          priority,
          executor: "minion",
          minionSessionKey: minionKey,
          leaderSessionKey: ctx.leaderSessionKey,
          status: "running",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        };
        ctx.taskState.tasks.set(taskId, record);
      }

      // Build the minion's initial prompt
      const prompt = [
        "## Task Assignment\n",
        `**Task ID:** ${taskId}`,
        `**Title:** ${title}`,
        `**Priority:** ${priority}\n`,
        `**Description:**\n${description}\n`,
        "Please execute this task now.",
      ].join("\n");

      // Arm the minion with any requested skills by appending their
      // compiled instructions to the minion's system prompt. Unknown
      // skill IDs are silently dropped by `loadSkillsByIds`.
      const requestedIds = skillIds ?? [];
      const skills = loadSkillsByIds(ctx.projectPath, requestedIds);
      const armedSkillIds = skills.map((s) => s.id);
      const skillsAddendum = compileSkills(skills, skillValues ?? {});
      const minionSystemPrompt = ctx.minionSystemPrompt + skillsAddendum;

      // Start the minion session on the server
      ctx.startMinionSession({
        sessionKey: minionKey,
        prompt,
        cwd: ctx.cwd,
        systemPrompt: minionSystemPrompt,
      });

      // Broadcast: minion_spawned so Canvas creates the node
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "minion_spawned",
        leaderSessionKey: ctx.leaderSessionKey,
        minionSessionKey: minionKey,
        taskId,
        title,
        description,
        priority,
        worktreeBranch: ctx.worktreeBranch ?? null,
        skillIds: armedSkillIds,
        timestamp: Date.now(),
      });

      // Broadcast: full plan update so frontend reflects "running" status
      emitTaskPlanUpdate(ctx.bus, ctx.leaderSessionKey, ctx.taskState, ctx.onStateChange);

      const armedNote =
        armedSkillIds.length > 0
          ? ` Armed with skills: ${armedSkillIds.join(", ")}.`
          : "";
      const droppedNote =
        requestedIds.length > armedSkillIds.length
          ? ` (Skipped unknown skill IDs: ${requestedIds
              .filter((id) => !armedSkillIds.includes(id))
              .join(", ")}.)`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Task "${title}" (${taskId}) delegated to minion ${minionKey}. The minion session has started and is executing the task autonomously.${armedNote}${droppedNote}`,
          },
        ],
      };
    },
  );
}
