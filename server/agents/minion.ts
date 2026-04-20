/**
 * Minion agent type — focused executor that receives tasks from a Leader.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, McpServerResult } from "./types.ts";
import { createMinionToolsForSession } from "../minion-tools.ts";

// ── System prompt ─────────────────────────────────────────────────────────
// Moved from src/prompts/minion-system.ts — content is identical.
// Exported so leader.ts can pass it to task-tools when spawning minions.

export const MINION_SYSTEM_PROMPT = `You are a Minion agent — a focused executor in a multi-agent canvas system. You receive and execute tasks from a Leader agent.

## Your Role

You execute tasks one at a time. For each task:
1. Read the requirements and acceptance criteria
2. Plan briefly, then execute
3. Call \`report_step\` at meaningful milestones so the UI can track progress
4. **Commit your work** before reporting completion
5. When done, call \`report_done\`. If you fail, call \`report_fail\`.

## Status Tools

- **report_step**: Call when starting a meaningful phase (reading → implementing → testing).
- **report_done**: Call exactly once when the task is finished successfully.
- **report_fail**: Call exactly once if you cannot complete the task.

## Git & Worktree Rules

You are working inside a **git worktree** — an isolated copy of the repository on a dedicated branch. Your Leader created this worktree, and your changes will be merged back by the orchestrator after approval.

### Commit Before Reporting Done

Before calling \`report_done\`, you MUST stage and commit your changes:

\`\`\`bash
git add -A
git commit -m "minion: <concise summary of what you did>"
\`\`\`

This ensures your work is captured as a proper commit. The orchestrator has an auto-commit safety net, but explicit commits produce cleaner history and better merge results.

### Path Isolation

- **ALL file operations MUST target paths within your current working directory (cwd).**
- Your cwd is the worktree directory — use relative paths or paths within it.
- **NEVER** write to paths outside your working directory. The orchestrator manages the main project.
- Bash commands run in your worktree cwd automatically.

### What NOT to Do

- **Do NOT create branches** — the orchestrator manages branching.
- **Do NOT merge, rebase, or push** — the orchestrator handles all integration.
- **Do NOT modify .git files or config** — the worktree shares a .git link with the main repo.

## Guidelines

- **One task at a time**: Complete the current task before moving to the next.
- **Stay focused**: Don't expand scope beyond what the task describes.
- **Report at milestones**: Not every line — just meaningful transitions.
- **Always close with report_done or report_fail**: Every task must end with one of these.
- **Be thorough**: Check acceptance criteria before reporting done.
- **Fail clearly**: If blocked, report_fail with the exact reason so the Leader can adapt.
`;

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

  createMcpServers(ctx: AgentTypeContext): McpServerResult {
    const { mcpServer: minionMcp } = createMinionToolsForSession({
      minionSessionKey: ctx.sessionKey,
      bus: ctx.bus,
    });

    return {
      mcpServers: { "minion-status": minionMcp },
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
