/**
 * Minion agent type — focused executor that receives tasks from a Leader.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createMinionToolsForSession } from "../minion-tools.ts";
import { createSubskillToolsForSession } from "../subskill-tools.ts";
import { createSkillAuthoringTools } from "../skill-authoring-tools.ts";
import {
  loadArmedSystemPrompt,
  persistTaskState,
} from "../session-persist.ts";
import type { TaskManagerState, TaskRecord } from "../task-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../../shared/prompts/minion-system.ts";
import { applyLifecycleEvent } from "../task-lifecycle.ts";
import {
  MINION_MCP_TOOLS_BASE,
  SKILL_AUTHORING_TOOLS,
  SKILL_BUILDER_ID,
  minionSkillMcpToolNames,
} from "./minion-tool-policy.ts";

// Re-exported so leader.ts can pass it to task-tools when spawning minions.
export { MINION_SYSTEM_PROMPT };

/**
 * Always-available minion tool names: status reporting + sub-skill retrieval.
 * The skill-authoring tools are gated separately (see SKILL_AUTHORING_TOOLS).
 */
const REPORT_NUDGE_PROMPT =
  "Your task is still open. Inspect acceptance criteria, required outputs, and evidence. Continue unfinished authorized work. Call mcp__minion-status__report_done only when verified and submitted, using any mode-specific verdict protocol. If a Leader decision is needed, call report_blocked and end this turn without a terminal report. Use report_fail only for an unrecoverable failure and preserve partial evidence and remaining gaps.";

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
  const next = applyLifecycleEvent({
    bus: ctx.bus,
    leaderSessionKey: leaderKey,
    taskState,
    taskId,
    event,
  });
  if (next && persistTaskState(leaderKey, taskState)) {
    ctx.wakeWaitingLeaderIfAllChildrenTerminal?.(leaderKey);
  }
}

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
    const projectPath = ctx.parentWorktree?.projectPath ?? ctx.worktreeInfo?.projectPath ?? ctx.cwd;
    const { toolDefs: subskillDefs } = createSubskillToolsForSession({
      projectPath,
      skillSnapshotId: ctx.skillSnapshotId,
      skillValues: ctx.skillValues,
    });

    // Skill-authoring tools are opt-in: load them only when this run was armed
    // with `skill-builder`. Canonical graph children do not have a legacy
    // parent TaskRecord, so the run context is the authority; retain the
    // TaskRecord fallback for legacy/direct children.
    const hasSkillBuilder =
      (ctx.skillIds?.includes(SKILL_BUILDER_ID) ?? false)
      || (parent?.task.skillIds?.includes(SKILL_BUILDER_ID) ?? false);
    const skillAuthoringDefs = hasSkillBuilder
      ? createSkillAuthoringTools({ projectPath })
      : [];

    return {
      toolGroups: {
        "minion-status": toolDefs,
        ...(ctx.taskGraphToolDefs?.length ? { "task-graph":ctx.taskGraphToolDefs } : {}),
        skills: [...subskillDefs, ...skillAuthoringDefs],
      },
      mcpToolNames: [
        ...MINION_MCP_TOOLS_BASE,
        ...minionSkillMcpToolNames(hasSkillBuilder ? [SKILL_BUILDER_ID] : []),
        ...(ctx.taskGraphToolDefs?.map(def => `mcp__task-graph__${def.name}`) ?? []),
      ],
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
          systemPrompt:
            loadArmedSystemPrompt(ctx.sessionKey) ?? MINION_SYSTEM_PROMPT,
        });
      }
      return;
    }

    const terminalResult = (result["result"] as string | null | undefined)
      ?? (isError ? "Task failed" : "Session completed without a final report.");
    applyParentLifecycleEvent(ctx, parent.leaderKey, parent.taskState, parent.task.taskId,
      isError
        ? { type: "session_ended", reason: "error", result: terminalResult }
        : { type: "reported_done", result: terminalResult });
  },
};

registerAgentType(minionAgent);
