/**
 * Task management MCP tools for the Leader agent.
 *
 * This barrel re-exports public types and assembles per-tool factories
 * into a single `createTaskToolsForLeader` entry point.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "./bus.ts";
import type { WorktreeInfo } from "./worktree.js";

// Re-export public types so callers keep importing from "server/task-tools"
export type {
  TaskRecord,
  PendingWait,
  ApprovalState,
  TaskManagerState,
} from "./task-tools/types.ts";

import type { TaskManagerState, TaskToolContext } from "./task-tools/types.ts";
import { createPlanTaskTool } from "./task-tools/plan-task.ts";
import { createAssignTaskTool } from "./task-tools/assign-task.ts";
import { createCompleteTaskTool } from "./task-tools/complete-task.ts";
import { createGetTaskStatusTool } from "./task-tools/get-task-status.ts";
import { createWaitAndContinueTool } from "./task-tools/wait-and-continue.ts";
import { createSetTaskNameTool } from "./task-tools/set-task-name.ts";
import { createRequestApprovalTool } from "./task-tools/request-approval.ts";

// ── Factory ────────────────────────────────────────────

/**
 * Create task management MCP tools bound to a specific leader session.
 *
 * Returns:
 *  - `mcpServer` config to pass into `query()` options.mcpServers
 *  - `taskState` so the server can inspect tasks externally
 */
export function createTaskToolsForLeader(opts: {
  leaderSessionKey: string;
  bus: Bus;
  startMinionSession: (params: {
    sessionKey: string;
    prompt: string;
    cwd: string;
    systemPrompt: string;
  }) => void;
  cwd: string;
  minionSystemPrompt: string;
  existingTaskState?: TaskManagerState;
  worktreeBranch?: string | null;
  worktreeInfo?: WorktreeInfo | null;
  worktreeIsolation?: boolean;
  scheduleWaitContinue: (durationMs: number, reason: string) => void;
  onStateChange?: (state: TaskManagerState) => void;
}) {
  const taskState: TaskManagerState = opts.existingTaskState ?? {
    tasks: new Map(),
    pendingWait: null,
    approval: null,
  };

  const ctx: TaskToolContext = {
    leaderSessionKey: opts.leaderSessionKey,
    bus: opts.bus,
    startMinionSession: opts.startMinionSession,
    cwd: opts.cwd,
    minionSystemPrompt: opts.minionSystemPrompt,
    taskState,
    onStateChange: opts.onStateChange,
    worktreeBranch: opts.worktreeBranch,
    worktreeInfo: opts.worktreeInfo,
    worktreeIsolation: opts.worktreeIsolation,
    scheduleWaitContinue: opts.scheduleWaitContinue,
  };

  const baseTools = [
    createPlanTaskTool(ctx),
    createAssignTaskTool(ctx),
    createCompleteTaskTool(ctx),
    createGetTaskStatusTool(ctx),
    createSetTaskNameTool(ctx),
    createWaitAndContinueTool(ctx),
  ];

  // Only add request_approval when worktree isolation is active
  const allTools = (opts.worktreeIsolation && opts.worktreeInfo)
    ? [...baseTools, createRequestApprovalTool(ctx)]
    : baseTools;

  const mcpServer = createSdkMcpServer({
    name: "task-manager",
    tools: allTools as never,
  });

  return { mcpServer, taskState };
}
