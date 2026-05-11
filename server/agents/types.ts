/**
 * AgentType interface — the pluggable contract that each agent role implements.
 *
 * Adding a new agent role (Reviewer, Planner, Context-Explorer) should be
 * ~50 lines of new code: implement AgentType, call registerAgentType().
 * No edits to server/index.ts needed.
 */

import type { Bus } from "../bus.ts";
import type { TaskManagerState } from "../task-tools.ts";
import type { RenderState } from "../render-tools.ts";
import type { WorktreeInfo } from "../worktree.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

// ── Context passed to every AgentType method ──────────────────────────────

export interface AgentTypeContext {
  sessionKey: string;
  cwd: string;
  bus: Bus;
  worktreeInfo: WorktreeInfo | null;
  worktreeIsolation: boolean;
  /** Existing task state to preserve across resume calls (leader only) */
  existingTaskState?: TaskManagerState;
  /** Existing render state to preserve across resume calls (leader only) */
  existingRenderState?: RenderState;
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
    prompt: string;
    cwd: string;
    systemPrompt: string;
    model?: string;
    harness?: string;
  }) => void;
  /** Callback to schedule a delayed "Continue" resume (leader only) */
  scheduleWaitContinue?: (durationMs: number, reason: string) => void;
  /**
   * Iterate over all sessions that have a taskState (i.e., leaders).
   * Used by minion onComplete to propagate results back.
   */
  forEachLeaderTaskState?: (
    fn: (leaderKey: string, taskState: TaskManagerState) => void,
  ) => void;
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
   * Handle post-completion behavior.
   * E.g., minion propagates results to the leader's taskState.
   */
  onComplete?(ctx: AgentTypeContext, result: Record<string, unknown>): void | Promise<void>;

  /**
   * Whether this agent type should detect subagent events.
   * Only the leader watches for task_started/task_notification.
   */
  detectsSubagents?: boolean;
}
