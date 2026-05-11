/**
 * Minion agent type — focused executor that receives tasks from a Leader.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createMinionToolsForSession } from "../minion-tools.ts";
import { emitTaskPlanUpdate } from "../task-tools/shared.ts";
import { persistTaskState } from "../session-persist.ts";
import type { TaskManagerState, TaskRecord } from "../task-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../../shared/prompts/minion-system.ts";

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

function persistAndBroadcastTaskState(
  ctx: AgentTypeContext,
  leaderKey: string,
  taskState: TaskManagerState,
): void {
  emitTaskPlanUpdate(ctx.bus, leaderKey, taskState, (state) =>
    persistTaskState(leaderKey, state),
  );
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
          if (parent.task.status === "planned") parent.task.status = "running";
          persistAndBroadcastTaskState(ctx, parent.leaderKey, parent.taskState);
          return;
        }

        parent.task.status = report.trigger === "done" ? "completed" : "failed";
        parent.task.completedAt = report.timestamp;
        parent.task.result = report.message;
        persistAndBroadcastTaskState(ctx, parent.leaderKey, parent.taskState);
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

    const isError = !!(result["is_error"]);
    const alreadyClosed =
      parent.task.status === "completed" || parent.task.status === "failed";
    if (!alreadyClosed) {
      parent.task.status = isError ? "failed" : "completed";
      parent.task.completedAt = Date.now();
      parent.task.result =
        (result["result"] as string) ??
        (isError ? "Task failed" : "Task completed");
    }

    // Broadcast the authoritative plan even when report_done/report_fail
    // already closed the task, so late-revealed leader nodes and persisted
    // state converge after the SDK turn fully settles.
    persistAndBroadcastTaskState(ctx, parent.leaderKey, parent.taskState);
  },
};

registerAgentType(minionAgent);
