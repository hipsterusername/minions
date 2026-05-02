/**
 * Shared types for the task management MCP tools.
 */

import type { Bus } from "../bus.ts";
import type { WorktreeInfo, DetailedDiff } from "../worktree.js";

// ── Public state types ────────────────────────────────

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  /** Who is executing this task */
  executor: "leader" | "minion";
  minionSessionKey: string | null;
  leaderSessionKey: string;
  /** planned → running → completed | failed */
  status: "planned" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt: number | null;
  result: string | null;
}

export interface PendingWait {
  durationMs: number;
  reason: string;
  scheduledAt: number;
  /** Node.js timer handle — allows cancellation if the session is stopped */
  timerId: ReturnType<typeof setTimeout> | null;
}

export interface ApprovalState {
  /** Whether approval has been requested */
  requested: boolean;
  /** Timestamp of the request */
  requestedAt: number;
  /** Summary provided by the leader */
  summary: string;
  /** Detailed diff at the time of request */
  diff: DetailedDiff | null;
}

export interface TaskManagerState {
  tasks: Map<string, TaskRecord>;
  /** If set, the leader has requested a wait-then-continue cycle */
  pendingWait: PendingWait | null;
  /** If set, the leader is waiting for user approval of worktree changes */
  approval: ApprovalState | null;
}

// ── Shared context passed to each tool factory ────────

export interface TaskToolContext {
  leaderSessionKey: string;
  bus: Bus;
  startMinionSession: (params: {
    sessionKey: string;
    prompt: string;
    cwd: string;
    systemPrompt: string;
  }) => void;
  cwd: string;
  /**
   * The canonical project path (sidecar root). When the leader is running
   * inside a git worktree, `cwd` points at the worktree but `projectPath`
   * still points at the original checkout where `.minions/skills.json`
   * lives. Falls back to `cwd` when no worktree is in use.
   */
  projectPath: string;
  minionSystemPrompt: string;
  taskState: TaskManagerState;
  onStateChange?: (state: TaskManagerState) => void;
  worktreeBranch?: string | null;
  worktreeInfo?: WorktreeInfo | null;
  worktreeIsolation?: boolean;
  scheduleWaitContinue: (durationMs: number, reason: string) => void;
}
