/**
 * AgentType interface — the pluggable contract that each agent role implements.
 *
 * Adding a new agent role (Reviewer, Planner, Context-Explorer) should be
 * ~50 lines of new code: implement AgentType, call registerAgentType().
 * No edits to server/index.ts needed.
 */

import type { Bus } from "../bus.ts";
import type { RunMutationCoordination } from "../mutation-coordination.ts";
import type { RuntimeSessionInfo, TaskManagerState } from "../task-tools.ts";
import type { RenderState } from "../../shared/render-dsl.ts";
import type { WorktreeInfo } from "../worktree.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import type { ThinkingConfig } from "../session-host-config.ts";
import type { SessionTerminateReason } from "../session-host-terminate.ts";
import type { SessionInvocationKind } from "../session-host-types.ts";

// ── Context passed to every AgentType method ──────────────────────────────

export interface AgentTypeContext {
  sessionKey: string;
  workItemId?: string | null;
  runKey?: string;
  taskId?: string | null;
  cwd: string;
  bus: Bus;
  worktreeInfo: WorktreeInfo | null;
  worktreeIsolation: boolean;
  mutationCoordination?: RunMutationCoordination;
  /** Existing task state to preserve across resume calls (leader only) */
  existingTaskState?: TaskManagerState;
  /** Existing render state to preserve across resume calls (leader only) */
  existingRenderState?: RenderState;
  /**
   * Skill IDs tagged on this session (leader only). They gate opt-in tool
   * surfaces and are inherited by delegated Minions. Sourced from the
   * frontend at launch time and persisted across resume/wait cycles.
   */
  skillIds?: string[];
  /** Template values configured for the tagged Leader skills. */
  skillValues?: Record<string, Record<string, string>>;
  /** Worktree inherited from the leader (minion only) */
  parentWorktree?: WorktreeInfo;
  /**
   * Callback to start a minion session (leader only — wired by the server).
   *
   * The optional `harness` field selects which AgentHarness drives the
   * spawned minion. When omitted, the host wrapper defaults it to the
   * leader's current `harnessName` so a Codex leader spawns Codex minions
   * unless an agent type explicitly overrides it.
   */
  startMinionSession?: (params: {
    sessionKey: string;
    taskId?: string;
    invocationKind?: SessionInvocationKind;
    prompt: string;
    cwd: string;
    systemPrompt: string;
    model?: string;
    harness?: string;
    thinkingConfig?: ThinkingConfig;
    permissionMode?: string;
    executorClass?: "mechanical" | "standard" | "reasoning";
    skillIds?: string[];
    onAllocated?: (sessionKey: string) => void;
  }) => void | Promise<{ sessionKey: string; harness: string; model: string; permissionMode: string }>;
  /** Callback to schedule a delayed "Continue" resume (leader only) */
  scheduleWaitContinue?: (durationMs: number, reason: string) => ReturnType<typeof setTimeout> | null | void;
  /** Callback to terminate another live session by key. */
  terminateSession?: (sessionKey: string, reason: SessionTerminateReason) => void;
  /**
   * Inject a steering message into a live session as a new user turn.
   * Returns whether it was delivered plus the session's status, so callers
   * can surface a useful error for ended sessions.
   */
  messageSession?: (
    sessionKey: string,
    message: string,
  ) => { delivered: boolean; status: string | null };
  /** Wake a waiting leader as soon as every child task is terminal. */
  wakeWaitingLeaderIfAllChildrenTerminal?: (leaderKey: string) => void;
  cleanupLiveEditRun?: (runKey: string) => void;
  /**
   * Iterate over all sessions that have a taskState (i.e., leaders).
   * Used by minion onComplete to propagate results back.
   */
  forEachLeaderTaskState?: (
    fn: (leaderKey: string, taskState: TaskManagerState) => void,
  ) => void;
  /** Return live host/session metadata for a known session key, if loaded. */
  getSessionRuntime?: (sessionKey: string) => RuntimeSessionInfo | null;
  /** Latest render components for safe checkpoint-boundary validation. */
  getRenderComponents?: () => RenderState["components"];
  /** Update and persist the durable display name for this session. */
  updateTaskName?: (name: string) => void;
  /** Raise a durable, structured user-input requirement for Activity. */
  markDecisionNeeded?: (reason: string) => void;
  /** Advance the persisted dashboard revision after a render mutation. */
  markDashboardChanged?: () => void;
}

// ── Agent tool result ─────────────────────────────────────────────────────

/**
 * Harness-agnostic tool registration result from an agent type.
 *
 * `toolGroups` maps MCP server name → NormalizedToolDef array so the harness
 * creates one server per entry and tool call names remain
 * `mcp__<serverName>__<toolName>`. Each harness wraps these in its own format
 * via `harness.registerTools(toolGroups)`.
 */
export interface AgentToolResult {
  /** Grouped tool definitions — key is the MCP server name. */
  toolGroups: Record<string, NormalizedToolDef[]>;
  /** Flat list of fully-qualified tool names for the allowedTools list. */
  mcpToolNames: string[];
  /** Optional task manager state (leader only) */
  taskState?: TaskManagerState;
  /** Optional render state (leader only) */
  renderState?: RenderState;
}

// ── AgentType interface ───────────────────────────────────────────────────

export interface AgentType {
  /** Unique agent role identifier: "leader" | "minion" | "default" | future types */
  id: string;

  /**
   * Build the full system prompt, including worktree rules if applicable.
   *
   * @param tools - Coding tool names to inject into the prompt body. Passed by
   *   `buildHarnessStartOpts` as `harness.builtInTools` so a non-Claude harness
   *   can supply its own list. Implementations that don't interpolate tools may
   *   ignore this parameter.
   */
  buildSystemPrompt(ctx: AgentTypeContext, customPrompt?: string, tools?: string[]): string | undefined;

  /**
   * Return the harness-agnostic tool definitions for this agent type.
   * The host calls `harness.registerTools(result.toolGroups)` before start().
   * Return empty toolGroups/mcpToolNames for roles that don't need MCP tools.
   */
  getToolGroups(ctx: AgentTypeContext): AgentToolResult;

  /** Whether this agent type wants worktree isolation. */
  wantsWorktree: boolean;

  /**
   * Handle post-completion behavior of a single RUN (one `done` event —
   * i.e. the agent finished a turn, not necessarily the session's life).
   * E.g., minion propagates results to the leader's taskState.
   *
   * Do NOT use this hook for teardown that should only happen when the
   * session itself goes away — that's `onTerminate`. A leader finishes a
   * run every time it ends a turn while its minions keep working.
   */
  onComplete?(ctx: AgentTypeContext, result: Record<string, unknown>): void | Promise<void>;

  /**
   * Handle teardown when the SESSION is terminated (stop/close/remove/abort
   * of the session itself, via `terminateSessionHost`). E.g., the leader
   * aborts still-running minion sessions when it is closed or removed.
   */
  onTerminate?(ctx: AgentTypeContext, reason: SessionTerminateReason): void;

  /**
   * Whether this agent type should detect subagent events.
   * Only the leader watches for task_started/task_notification.
   */
  detectsSubagents?: boolean;
}
