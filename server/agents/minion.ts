/**
 * Minion agent type — focused executor that receives tasks from a Leader.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createMinionToolsForSession } from "../minion-tools.ts";
import { persistTaskState } from "../session-persist.ts";
import type { TaskManagerState, TaskRecord } from "../task-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../../shared/prompts/minion-system.ts";
import { applyLifecycleEvent } from "../task-lifecycle.ts";

// Re-exported so leader.ts can pass it to task-tools when spawning minions.
export { MINION_SYSTEM_PROMPT };

// ── MCP tool names ────────────────────────────────────────────────────────

const MINION_MCP_TOOLS = [
  "mcp__minion-status__report_step",
  "mcp__minion-status__report_done",
  "mcp__minion-status__report_fail",
];

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

    return {
      toolGroups: { "minion-status": toolDefs },
      mcpToolNames: MINION_MCP_TOOLS,
    };
  },

  wantsWorktree: false,
  detectsSubagents: false,

  onComplete(ctx: AgentTypeContext, result: Record<string, unknown>): void {
    const parent = findParentTask(ctx);
    if (!parent) return;

    const isError = !!result["is_error"];
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
