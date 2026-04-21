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
  /** Callback to start a minion session (leader only — wired by the server) */
  startMinionSession?: (params: {
    sessionKey: string;
    prompt: string;
    cwd: string;
    systemPrompt: string;
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

// ── MCP server result ─────────────────────────────────────────────────────

export interface McpServerResult {
  /** Map of MCP server name → MCP server object (from createSdkMcpServer) */
  mcpServers: Record<string, unknown>;
  /** Tool names to add to the allowedTools list */
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

  /** Build the full system prompt, including worktree rules if applicable. */
  buildSystemPrompt(ctx: AgentTypeContext, customPrompt?: string): string | undefined;

  /**
   * Create MCP servers for this agent type.
   * Return empty mcpServers/mcpToolNames for roles that don't need MCP tools.
   */
  createMcpServers(ctx: AgentTypeContext): McpServerResult;

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
