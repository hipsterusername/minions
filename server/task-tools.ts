/**
 * Task management MCP tools for the Leader agent.
 *
 * This barrel re-exports public types and assembles per-tool factories
 * into a single `createTaskToolsForLeader` entry point.
 *
 * Each per-tool factory returns a `NormalizedToolDef`. The barrel collects
 * them into a flat `NormalizedToolDef[]` which agents/leader.ts places into
 * toolGroups. ClaudeHarness.registerTools() wraps each group as a named MCP
 * server so tool calls follow the mcp__task-manager__* pattern.
 */

import type { NormalizedToolDef } from "./harness/types.ts";
import type { Bus } from "./bus.ts";
import type { WorktreeInfo } from "./worktree.js";
import type { LoadedSystemModel } from "./system-model/types.ts";
import type { RenderComponent } from "../shared/render-dsl.ts";
import type { LeaderPlanningBackend } from "../shared/leader-planning.ts";

// Re-export public types so callers keep importing from "server/task-tools"
export type {
  TaskRecord,
  RuntimeSessionInfo,
  PendingWait,
  ApprovalState,
  TaskManagerState,
} from "./task-tools/types.ts";

import type {
  RuntimeSessionInfo,
  TaskManagerState,
  TaskToolContext,
} from "./task-tools/types.ts";
import { createPlanTaskToolDef } from "./task-tools/plan-task.ts";
import { createAssignTaskToolDef } from "./task-tools/assign-task.ts";
import { createCompleteTaskToolDef } from "./task-tools/complete-task.ts";
import { createCancelTaskToolDef } from "./task-tools/cancel-task.ts";
import { createMessageTaskToolDef } from "./task-tools/message-task.ts";
import { createGetTaskStatusToolDef } from "./task-tools/get-task-status.ts";
import { createWaitAndContinueToolDef } from "./task-tools/wait-and-continue.ts";
import { createSetTaskNameToolDef } from "./task-tools/set-task-name.ts";
import { createRequestApprovalToolDef } from "./task-tools/request-approval.ts";
import { createCheckpointSessionToolDef } from "./task-tools/checkpoint-session.ts";
import { createLoadSubskillToolDef } from "./task-tools/load-subskill.ts";

/**
 * Create task management tool definitions bound to a specific leader session.
 *
 * Returns:
 *  - `toolDefs` — flat NormalizedToolDef[] to pass to harness.registerTools()
 *    (or wrapTools() for the Claude harness).
 *  - `taskState` so the server can inspect tasks externally.
 */
export function createTaskToolsForLeader(opts: {
  leaderSessionKey: string;
  bus: Bus;
  startMinionSession: (params: {
    sessionKey: string;
    taskId?: string;
    attemptId?: string;
    attemptNumber?: number;
    prompt: string;
    cwd: string;
    systemPrompt: string;
    model?: string;
    harness?: string;
  }) => void;
  cwd: string;
  /**
   * Canonical project path (sidecar root) — see `TaskToolContext.projectPath`.
   * Defaults to `cwd` when omitted (no-worktree case).
   */
  projectPath?: string;
  minionSystemPrompt: string;
  /** Skills selected on the Leader and inherited by each spawned Minion. */
  defaultMinionSkillIds?: readonly string[];
  /** Template values configured for the inherited Leader-selected skills. */
  defaultMinionSkillValues?: Record<string, Record<string, string>>;
  /** Loaded system model (active layer) for the packet-required trigger. */
  systemModel?: LoadedSystemModel | null;
  existingTaskState?: TaskManagerState;
  worktreeBranch?: string | null;
  worktreeInfo?: WorktreeInfo | null;
  worktreeIsolation?: boolean;
  scheduleWaitContinue: (durationMs: number, reason: string) => ReturnType<typeof setTimeout> | null | void;
  terminateSession?: (sessionKey: string, reason: "abort") => void;
  messageSession?: (
    sessionKey: string,
    message: string,
  ) => { delivered: boolean; status: string | null };
  taskTimeoutMs?: number;
  getSessionRuntime?: (sessionKey: string) => RuntimeSessionInfo | null;
  onStateChange?: (state: TaskManagerState) => void;
  onTaskNameChange?: (name: string) => void;
  getRenderComponents?: () => RenderComponent[];
  planningBackend?: LeaderPlanningBackend;
}): { toolDefs: NormalizedToolDef[]; taskState: TaskManagerState } {
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
    projectPath: opts.projectPath ?? opts.cwd,
    minionSystemPrompt: opts.minionSystemPrompt,
    defaultMinionSkillIds: opts.defaultMinionSkillIds,
    defaultMinionSkillValues: opts.defaultMinionSkillValues,
    systemModel: opts.systemModel ?? null,
    taskState,
    getSessionRuntime: opts.getSessionRuntime,
    onStateChange: opts.onStateChange,
    onTaskNameChange: opts.onTaskNameChange,
    worktreeBranch: opts.worktreeBranch,
    worktreeInfo: opts.worktreeInfo,
    worktreeIsolation: opts.worktreeIsolation,
    scheduleWaitContinue: opts.scheduleWaitContinue,
    terminateSession: opts.terminateSession,
    messageSession: opts.messageSession,
    taskTimeoutMs: opts.taskTimeoutMs,
    getRenderComponents: opts.getRenderComponents,
  };

  const directDefs = [
    createPlanTaskToolDef(ctx),
    createAssignTaskToolDef(ctx),
    createCompleteTaskToolDef(ctx),
    createCancelTaskToolDef(ctx),
    createMessageTaskToolDef(ctx),
    createGetTaskStatusToolDef(ctx),
    createSetTaskNameToolDef(ctx),
    createWaitAndContinueToolDef(ctx),
    createCheckpointSessionToolDef(ctx),
    createLoadSubskillToolDef(ctx),
  ];
  const graphDefs = [
    createSetTaskNameToolDef(ctx),
    createCheckpointSessionToolDef(ctx),
    createLoadSubskillToolDef(ctx),
  ];
  const baseDefs = opts.planningBackend === "task_graph" ? graphDefs : directDefs;

  // Only add request_approval when worktree isolation is active
  const toolDefs: NormalizedToolDef[] =
    opts.worktreeIsolation && opts.worktreeInfo
      ? [...baseDefs, createRequestApprovalToolDef(ctx)]
      : baseDefs;

  return { toolDefs, taskState };
}
