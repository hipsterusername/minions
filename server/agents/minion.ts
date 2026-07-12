/**
 * Minion agent type — focused executor that receives tasks from a Leader.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createMinionToolsForSession } from "../minion-tools.ts";
import { createSubskillToolsForSession } from "../subskill-tools.ts";
import { createSkillAuthoringTools } from "../skill-authoring-tools.ts";
import { persistTaskState } from "../session-persist.ts";
import type { TaskManagerState, TaskRecord } from "../task-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../../shared/prompts/minion-system.ts";
import { applyLifecycleEvent } from "../task-lifecycle.ts";

// Re-exported so leader.ts can pass it to task-tools when spawning minions.
export { MINION_SYSTEM_PROMPT };

// ── MCP tool names ────────────────────────────────────────────────────────

/**
 * Always-available minion tool names: status reporting + sub-skill retrieval.
 * The skill-authoring tools are gated separately (see SKILL_AUTHORING_TOOLS).
 */
const MINION_MCP_TOOLS_BASE = [
  "mcp__minion-status__report_step",
  "mcp__minion-status__report_done",
  "mcp__minion-status__report_fail",
  "mcp__minion-status__report_blocked",
  "mcp__skills__load_subskill",
];

/**
 * Skill-authoring tool names — opt-in. Only loaded for a minion whose task
 * armed the `skill-builder` skill. Keeps ~1.5k tokens of tool schemas off
 * every other minion.
 */
const SKILL_AUTHORING_TOOLS = [
  "mcp__skills__list_skills",
  "mcp__skills__get_skill",
  "mcp__skills__create_skill",
  "mcp__skills__update_skill",
  "mcp__skills__delete_skill",
];

/** The skill ID that gates the skill-authoring tools. */
const SKILL_BUILDER_ID = "skill-builder";

const REPORT_NUDGE_PROMPT =
  "Your task is still open. Call mcp__minion-status__report_done with a one-line summary of what you completed, or report_fail with what blocked you. Do not start new work.";

function findParentTask(
  ctx: AgentTypeContext,
): { leaderKey: string; taskState: TaskManagerState; task: TaskRecord } | null {
  let found: { leaderKey: string; taskState: TaskManagerState; task: TaskRecord } | null = null;
  ctx.forEachLeaderTaskState?.((leaderKey, taskState) => {
    if (found) return;
    for (const task of taskState.tasks.values()) {
      if (task.minionSessionKey === ctx.sessionKey) {
        found = { leaderKey, taskState, task };
        return;
      }
    }
  });
  return found;
}

function applyParentLifecycleEvent(
  ctx: AgentTypeContext,
  leaderKey: string,
  taskState: TaskManagerState,
  taskId: string,
  event: Parameters<typeof applyLifecycleEvent>[0]["event"],
): void {
  applyLifecycleEvent({
    bus: ctx.bus,
    leaderSessionKey: leaderKey,
    taskState,
    taskId,
    event,
    onStateChange: (state) => persistTaskState(leaderKey, state),
  });
  ctx.wakeWaitingLeaderIfAllChildrenTerminal?.(leaderKey);
}

// ── AgentType implementation ──────────────────────────────────────────────

const minionAgent: AgentType = {
  id: "minion",

  buildSystemPrompt(_ctx: AgentTypeContext, customPrompt?: string): string {
    return customPrompt ?? MINION_SYSTEM_PROMPT;
  },

  getToolGroups(ctx: AgentTypeContext): AgentToolResult {
    const parent = findParentTask(ctx);
    const { toolDefs } = createMinionToolsForSession({
      minionSessionKey: ctx.sessionKey,
      bus: ctx.bus,
      leaderSessionKey: parent?.leaderKey ?? null,
      taskId: parent?.task.taskId ?? null,
      onReport: (report) => {
        if (!parent) return;
        if (report.trigger === "step") {
          applyParentLifecycleEvent(ctx, parent.leaderKey, parent.taskState, parent.task.taskId, {
            type: "reported_step",
            message: report.message,
          });
          return;
        }

        if (report.trigger === "blocked") {
          applyParentLifecycleEvent(ctx, parent.leaderKey, parent.taskState, parent.task.taskId, {
            type: "reported_blocked",
            question: report.message,
            timestamp: report.timestamp,
          });
          return;
        }

        applyParentLifecycleEvent(ctx, parent.leaderKey, parent.taskState, parent.task.taskId, {
          type: report.trigger === "done" ? "reported_done" : "reported_fail",
          result: report.message,
          timestamp: report.timestamp,
        });
      },
    });

    // Sub-skill retrieval reads the project's skill library. When the minion
    // runs inside a leader-inherited worktree, the sidecar lives at the
    // original checkout (parentWorktree.projectPath), not the worktree cwd.
    const projectPath = ctx.parentWorktree?.projectPath ?? ctx.cwd;
    const { toolDefs: subskillDefs } = createSubskillToolsForSession({
      projectPath,
    });

    // Skill-authoring tools are opt-in: load them only when the parent task
    // armed the `skill-builder` skill. Sub-skill retrieval stays always-on.
    const hasSkillBuilder =
      parent?.task.skillIds?.includes(SKILL_BUILDER_ID) ?? false;
    const skillAuthoringDefs = hasSkillBuilder
      ? createSkillAuthoringTools({ projectPath })
      : [];

    return {
      toolGroups: {
        "minion-status": toolDefs,
        skills: [...subskillDefs, ...skillAuthoringDefs],
      },
      mcpToolNames: hasSkillBuilder
        ? [...MINION_MCP_TOOLS_BASE, ...SKILL_AUTHORING_TOOLS]
        : MINION_MCP_TOOLS_BASE,
    };
  },

  wantsWorktree: false,
  detectsSubagents: false,

  onComplete(ctx: AgentTypeContext, result: Record<string, unknown>): void {
    const parent = findParentTask(ctx);
    if (!parent) return;

    // A blocked minion ended its turn deliberately to await a leader decision.
    // The session stays idle and resumable via message_task; do NOT terminalize
    // it with session_ended here.
    if (parent.task.status === "blocked") return;

    const isError = !!result["is_error"];
    if (
      !isError &&
      (parent.task.status === "starting" || parent.task.status === "running") &&
      parent.task.nudgedAt == null &&
      ctx.startMinionSession
    ) {
      const nudged = applyLifecycleEvent({
        bus: ctx.bus,
        leaderSessionKey: parent.leaderKey,
        taskState: parent.taskState,
        taskId: parent.task.taskId,
        event: { type: "report_nudged" },
        onStateChange: (state) => persistTaskState(parent.leaderKey, state),
      });
      if (nudged !== parent.task) {
        ctx.startMinionSession({
          sessionKey: ctx.sessionKey,
          invocationKind: "resume_open_run",
          prompt: REPORT_NUDGE_PROMPT,
          cwd: ctx.cwd,
          systemPrompt: MINION_SYSTEM_PROMPT,
        });
      }
      return;
    }

    applyParentLifecycleEvent(ctx, parent.leaderKey, parent.taskState, parent.task.taskId, {
      type: "session_ended",
      reason: isError ? "error" : "clean",
      result:
        (result["result"] as string | null | undefined) ??
        (isError ? "Task failed" : null),
    });
  },
};

registerAgentType(minionAgent);
