/**
 * assign_task tool — Delegate a task to a new Minion session.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { textResult } from "../harness/tool-result.ts";
import type { TaskToolContext, TaskRecord } from "./types.ts";
import { compileSkills, loadSkillsByIds } from "../skills.ts";
import { readSettings, resolveMinionModelForHarness } from "../project-store.ts";
import { isValidThinkingConfig } from "../session-host-config.ts";
import { getSessionCanvasContext } from "../canvas-context-store.ts";
import { buildTaskSpawnPrompt } from "./task-prompt.ts";
import { hasSystemModelManifest } from "../system-model/load.ts";
import { getWorkPacketContextPack } from "../system-model/store.ts";
import { computePacketApplicability, renderPacketNote } from "../system-model/applicability.ts";
import {
  applyLifecycleEvent,
  isRetryableTaskStatus,
  scheduleTaskTimeout,
} from "../task-lifecycle.ts";

const assignTaskInputSchema = z.object({
  taskId: z
    .string()
    .describe(
      "Unique identifier for this task (use the same ID as plan_task if pre-planned)",
    ),
  title: z.string().describe("Short title for the task"),
  description: z
    .string()
    .describe(
      "Detailed description with acceptance criteria. Include all necessary context — file paths, function names, expected behavior, constraints.",
    ),
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
  executorClass: z
    .enum(["mechanical", "standard", "reasoning"])
    .optional()
    .describe(
      "Model tier for this minion: mechanical for low-ambiguity lint/rename/docs/format work, standard for normal implementation or investigation, reasoning for architecturally tricky or ambiguous work. Explicit model overrides this.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Exact model override for this minion. Takes precedence over executorClass and project defaults.",
    ),
  timeout_minutes: z
    .number()
    .min(1)
    .max(120)
    .optional()
    .describe("Inactivity budget for this task; default 30."),
  ownedPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Files/globs this minion may edit. Used to warn about overlap with concurrently running tasks.",
    ),
  skillIds: z
    .array(z.string())
    .optional()
    .describe(
      "Optional task-specific skill IDs from the project's skill library. These are added to the skills inherited from the Leader, and the compiled instructions are appended to the Minion's system prompt.",
    ),
  skillValues: z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional()
    .describe(
      "Optional per-task overrides for inherited skill template values, shaped as { skillId: { variableName: value } }. Only needed for skills whose templates declare {{placeholders}}.",
    ),
  include_canvas_context: z
    .boolean()
    .optional()
    .describe(
      "Whether to include the latest connected canvas-node context in the spawned minion prompt. Defaults to true.",
    ),
  workPacketId: z
    .string()
    .optional()
    .describe("Optional system-model Work Packet id whose stored Context Pack should be injected when the layer is active."),
});

export function createAssignTaskToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "assign_task",
    description:
      "Delegate a task to a new Minion agent. Creates a minion session that will execute the task autonomously. Use executorClass to choose mechanical, standard, or reasoning model tiers; pass model only for exact override. If the task was registered with plan_task, it will transition from planned to running. Skills selected on the Leader are inherited automatically; `skillIds` adds task-specific skills. Tasks that ended in failed/ended_without_report/orphaned may be re-assigned with the same taskId to retry.",
    inputSchema: assignTaskInputSchema,
    handler: async (input: unknown) => {
      const args = assignTaskInputSchema.parse(input);
      const { taskId, title, description, priority, skillIds, skillValues } = args;

      // Check lifecycle status — only allow planned and retryable terminal statuses
      const existing = ctx.taskState.tasks.get(taskId);
      if (existing) {
        const { status } = existing;
        if (status === "starting" || status === "running") {
          return textResult(
            `Task ${taskId} is already ${status}. Use get_task_status to check its progress.`,
          );
        }
        if (status === "completed") {
          return textResult(
            `Task ${taskId} is already completed. Task already completed; create a new task instead.`,
          );
        }
        if (status === "cancelled") {
          return textResult(
            `Task ${taskId} is already ${status}. Use get_task_status to check its progress.`,
          );
        }
        // "planned" and retryable terminal statuses (failed, ended_without_report,
        // orphaned) fall through to the spawn logic below.
      }

      // Track whether this is a retry for the result message
      const isRetry = existing != null && isRetryableTaskStatus(existing.status);
      const retryAttempt = isRetry ? (existing!.attempt ?? 1) + 1 : undefined;

      let minionKey = `minion-${Date.now().toString(36)}-${taskId.slice(0, 8)}`;

      if (existing) {
        existing.title = title;
        existing.description = description;
        existing.files = args.files ?? existing.files;
        existing.constraints = args.constraints ?? existing.constraints;
        existing.acceptanceCriteria =
          args.acceptanceCriteria ?? existing.acceptanceCriteria;
        existing.ownedPaths = args.ownedPaths ?? existing.ownedPaths;
        existing.priority = priority;
      } else {
        const record: TaskRecord = {
          taskId,
          title,
          description,
          files: args.files,
          constraints: args.constraints,
          acceptanceCriteria: args.acceptanceCriteria,
          ownedPaths: args.ownedPaths,
          priority,
          executor: "minion",
          minionSessionKey: minionKey,
          leaderSessionKey: ctx.leaderSessionKey,
          status: "planned",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        };
        ctx.taskState.tasks.set(taskId, record);
      }
      const task = ctx.taskState.tasks.get(taskId)!;

      // ── ownedPaths overlap detection ──────────────────────────────────
      const overlapWarnings: string[] = [];
      if (task.ownedPaths && task.ownedPaths.length > 0) {
        for (const otherTask of ctx.taskState.tasks.values()) {
          if (otherTask.taskId === taskId) continue;
          if (otherTask.leaderSessionKey !== ctx.leaderSessionKey) continue;
          if (otherTask.status !== "starting" && otherTask.status !== "running") continue;
          const otherPaths = otherTask.ownedPaths ?? [];
          const overlap = task.ownedPaths.filter((p) => otherPaths.includes(p));
          if (overlap.length > 0) {
            overlapWarnings.push(
              `Warning: ownedPaths overlap with running task ${otherTask.taskId}: ${overlap.join(", ")}`,
            );
          }
        }
      }

      const timeoutMs =
        args.timeout_minutes != null
          ? args.timeout_minutes * 60_000
          : ctx.taskTimeoutMs;

      // Every minion inherits the skills selected on its Leader. A tool call
      // may add task-specific skills; preserve order while avoiding duplicate
      // prompt sections when the Leader repeats an inherited ID.
      const requestedIds = [
        ...new Set([...(ctx.defaultMinionSkillIds ?? []), ...(skillIds ?? [])]),
      ];
      const skills = loadSkillsByIds(ctx.projectPath, requestedIds);
      const armedSkillIds = skills.map((s) => s.id);
      // Record the resolved skill IDs on the task so the spawned minion can
      // gate opt-in tool surfaces (e.g. skill-authoring tools) on them.
      // Re-fetch: the lifecycle/timeout events above replace the record
      // immutably, so the `task` captured earlier is now stale.
      const armedTask = ctx.taskState.tasks.get(taskId);
      if (armedTask) armedTask.skillIds = armedSkillIds;
      const inheritedValues = ctx.defaultMinionSkillValues ?? {};
      const resolvedSkillValues = { ...inheritedValues };
      for (const [skillId, taskValues] of Object.entries(skillValues ?? {})) {
        resolvedSkillValues[skillId] = {
          ...(inheritedValues[skillId] ?? {}),
          ...taskValues,
        };
      }
      const skillsAddendum = compileSkills(skills, resolvedSkillValues);
      const minionSystemPrompt = ctx.minionSystemPrompt + skillsAddendum;
      const settings = readSettings(ctx.projectPath);
      const contextPack = args.workPacketId && settings.systemModel !== "off" && hasSystemModelManifest(ctx.cwd)
        ? getWorkPacketContextPack(ctx.projectPath, args.workPacketId)
        : null;

      const prompt = buildTaskSpawnPrompt({
        taskId,
        title,
        priority,
        description,
        worktreeBranch: ctx.worktreeBranch,
        armedSkillIds,
        files: task.files,
        constraints: task.constraints,
        acceptanceCriteria: task.acceptanceCriteria,
        ownedPaths: task.ownedPaths,
        contextPack,
        canvasContext:
          args.include_canvas_context === false
            ? null
            : (ctx.getCanvasContext?.() ??
              getSessionCanvasContext(ctx.leaderSessionKey)),
      });

      const minionHarness =
        typeof settings.defaultMinionHarness === "string"
          ? settings.defaultMinionHarness
          : undefined;

      // Model precedence: per-task model > harness-compatible executorClass tier > defaults
      const minionModel =
        args.model ??
        resolveMinionModelForHarness(settings, minionHarness, args.executorClass);

      const minionThinkingConfig = isValidThinkingConfig(settings.defaultMinionThinkingConfig)
        ? settings.defaultMinionThinkingConfig
        : undefined;

      let launched: Awaited<ReturnType<TaskToolContext["startMinionSession"]>>;
      let allocationPersisted = false;
      const onAllocated = (authoritativeKey: string) => {
        minionKey = authoritativeKey;
        if (allocationPersisted) return;
        applyLifecycleEvent({ bus: ctx.bus, leaderSessionKey: ctx.leaderSessionKey,
          taskState: ctx.taskState, taskId,
          event: { type: "assigned", minionSessionKey: minionKey }, onStateChange: ctx.onStateChange });
        allocationPersisted = true;
      };
      try {
        launched = await ctx.startMinionSession({
          sessionKey: minionKey,
          taskId,
          prompt,
          cwd: ctx.cwd,
          systemPrompt: minionSystemPrompt,
          ...(minionModel ? { model: minionModel } : {}),
          ...(minionThinkingConfig ? { thinkingConfig: minionThinkingConfig } : {}),
          ...(minionHarness ? { harness: minionHarness } : {}),
          permissionMode: typeof settings.defaultPermissionMode === "string" ? settings.defaultPermissionMode : "auto",
          executorClass: args.executorClass,
          skillIds: armedSkillIds,
          onAllocated,
        });
        const allocatedKey = launched?.sessionKey;
        onAllocated(allocatedKey ?? minionKey);
        scheduleTaskTimeout({ bus: ctx.bus, leaderSessionKey: ctx.leaderSessionKey,
          taskState: ctx.taskState, taskId, timeoutMs, onStateChange: ctx.onStateChange,
          onTimeout: () => ctx.terminateSession?.(minionKey, "abort") });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Minion session launch failed.";
        onAllocated(minionKey);
        applyLifecycleEvent({
          bus: ctx.bus,
          leaderSessionKey: ctx.leaderSessionKey,
          taskState: ctx.taskState,
          taskId,
          event: { type: "session_ended", reason: "error", result: message },
          onStateChange: ctx.onStateChange,
        });
        return textResult(`Task ${taskId} could not start and may be retried: ${message}`);
      }

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
        model: launched?.model ?? minionModel ?? null,
        harness: launched?.harness ?? minionHarness ?? null,
        permissionMode: launched?.permissionMode ?? settings.defaultPermissionMode ?? "auto",
        timestamp: Date.now(),
      });

      // Only NEW information goes back to the model: the generated minion
      // key, plus any skill IDs that were silently dropped (armed skills are
      // derivable as requested-minus-dropped, so they are not repeated).
      const droppedNote =
        requestedIds.length > armedSkillIds.length
          ? ` Skipped unknown skill IDs: ${requestedIds
              .filter((id) => !armedSkillIds.includes(id))
              .join(", ")}.`
          : "";
      const retryNote = retryAttempt != null ? ` (attempt ${retryAttempt})` : "";
      const overlapNote =
        overlapWarnings.length > 0 ? `\n${overlapWarnings.join("\n")}` : "";

      // Redesign §5: deterministic packet-required trigger over files ∪ ownedPaths.
      // On a gate hit with no workPacketId passed, remind the leader to attach one
      // so the minion receives the Context Pack. Silent on a miss.
      const current = ctx.taskState.tasks.get(taskId);
      const scopedFiles = [
        ...(current?.files ?? task.files ?? []),
        ...(current?.ownedPaths ?? task.ownedPaths ?? []),
      ];
      const packetNote = ctx.systemModel
        ? renderPacketNote(computePacketApplicability(ctx.systemModel, scopedFiles), {
          remindWorkPacket: !args.workPacketId,
        })
        : "";

      return textResult(
        `Task ${taskId} delegated to minion ${minionKey}${retryNote}.${droppedNote}${overlapNote}${packetNote}`,
      );
    },
  };
}
