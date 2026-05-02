/**
 * Minion agent type — focused executor that receives tasks from a Leader.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { createMinionToolsForSession } from "../minion-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../../shared/prompts/minion-system.ts";

// Re-exported so leader.ts can pass it to task-tools when spawning minions.
export { MINION_SYSTEM_PROMPT };

// ── MCP tool names ────────────────────────────────────────────────────────

const MINION_MCP_TOOLS = [
  "mcp__minion-status__report_step",
  "mcp__minion-status__report_done",
  "mcp__minion-status__report_fail",
];

// ── AgentType implementation ──────────────────────────────────────────────

const minionAgent: AgentType = {
  id: "minion",

  buildSystemPrompt(_ctx: AgentTypeContext, customPrompt?: string): string {
    return customPrompt ?? MINION_SYSTEM_PROMPT;
  },

  getToolGroups(ctx: AgentTypeContext): AgentToolResult {
    const { toolDefs } = createMinionToolsForSession({
      minionSessionKey: ctx.sessionKey,
      bus: ctx.bus,
    });

    return {
      toolGroups: { "minion-status": toolDefs },
      mcpToolNames: MINION_MCP_TOOLS,
    };
  },

  wantsWorktree: false,
  detectsSubagents: false,

  onComplete(ctx: AgentTypeContext, result: Record<string, unknown>): void {
    if (!ctx.forEachLeaderTaskState) return;

    ctx.forEachLeaderTaskState((leaderKey, taskState) => {
      for (const [, task] of taskState.tasks) {
        if (task.minionSessionKey === ctx.sessionKey) {
          const isError = !!(result["is_error"]);
          task.status = isError ? "failed" : "completed";
          task.result =
            (result["result"] as string) ??
            (isError ? "Task failed" : "Task completed");
          // Broadcast so the frontend leader node and any subscribers learn
          // the task is done without needing to poll get_task_status.
          ctx.bus.emitToSession(leaderKey, {
            type: "minion_completed",
            leaderSessionKey: leaderKey,
            minionSessionKey: ctx.sessionKey,
            taskId: task.taskId,
            status: task.status,
            result: task.result,
            timestamp: Date.now(),
          });
          break;
        }
      }
    });
  },
};

registerAgentType(minionAgent);
