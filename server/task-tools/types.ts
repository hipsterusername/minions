/**
 * Shared types for the task management MCP tools.
 */

import type { Bus } from "../bus.ts";
import type { ThinkingConfig } from "../session-host-config.ts";
import type { SessionInvocationKind } from "../session-host-types.ts";
import type { WorktreeInfo, DetailedDiff } from "../worktree.js";
import type { MergeGateVerdict } from "../system-model/gates.ts";
import type { LoadedSystemModel } from "../system-model/types.ts";
import type { RenderComponent } from "../../shared/render-dsl.ts";

// ── Public state types ────────────────────────────────

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string;
  /** Files, paths, or symbols the task should read or change. */
  files?: string[];
  /** Invariants, boundaries, and do-not-touch rules for the task. */
  constraints?: string[];
  /** Observable conditions that define task completion. */
  acceptanceCriteria?: string[];
  /** Files/globs this minion may edit. */
  ownedPaths?: string[];
  /**
   * Resolved skill IDs armed on this task (after dropping unknown IDs).
   * Used to gate opt-in tool surfaces (e.g. the skill-authoring tools only
   * load for a minion whose task armed the `skill-builder` skill).
   */
  skillIds?: string[];
  priority: "low" | "medium" | "high" | "critical";
  /** Who is executing this task */
  executor: "leader" | "minion";
  minionSessionKey: string | null;
  leaderSessionKey: string;
  /** Server-owned lifecycle projection. */
  status: TaskStatus;
  createdAt: number;
  completedAt: number | null;
  result: string | null;
  /** Timestamp of the one-time report reminder after a silent clean run. */
  nudgedAt?: number;
  /** Most recent progress message from the executing minion. */
  lastStep?: string | null;
  /** Running count of reported_step events for this attempt. */
  stepCount?: number;
  /** 1-based attempt number; undefined/1 means first attempt. */
  attempt?: number;
  /** Archived records of previous attempts (filled on retry). */
  previousAttempts?: Array<{
    attempt: number;
    status: TaskStatus;
    result: string | null;
    completedAt: number | null;
  }>;
}

export type TaskStatus =
  | "planned"
  | "starting"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "ended_without_report"
  | "cancelled"
  | "orphaned";

export interface RuntimeSessionInfo {
  sessionKey: string;
  workItemId?: string | null;
  runKey?: string;
  runKind?: "primary" | "child";
  sessionId: string | null;
  status: string;
  role: string;
  cwd: string;
  model: string | null;
  harness: string;
  totalCost: number;
  turns: number;
  /** True when the host currently has an active harness run attached. */
  isLive: boolean;
  lastActivityAt: number | null;
  lastActivityAgeMs: number | null;
  lastEventType: string | null;
  lastSdkEventKind: string | null;
  lastError: string | null;
  lastErrorFull: string | null;
}

export interface PendingWait {
  durationMs: number;
  reason: string;
  scheduledAt: number;
  /** Node.js timer handle — allows cancellation if the session is stopped */
  timerId: ReturnType<typeof setTimeout> | null;
  /**
   * Semantics for waking a waiting leader (consumed by a later wave).
   * "any_terminal" — wake as soon as any awaited child reaches a terminal status.
   * "all_terminal" — wake only when every awaited child is terminal.
   */
  wakeOn?: "any_terminal" | "all_terminal";
}

export interface ApprovalState {
  /** Whether approval has been requested */
  requested: boolean;
  /** Timestamp of the request */
  requestedAt: number;
  /** Short grace window for the leader to render its approval dashboard */
  graceUntil?: number;
  /** Summary provided by the leader */
  summary: string;
  /** Detailed diff at the time of request */
  diff: DetailedDiff | null;
  /** System-model gate verdict at approval-request time (null when layer off). */
  gates?: MergeGateVerdict | null;
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
    taskId?: string;
    invocationKind?: SessionInvocationKind;
    prompt: string;
    cwd: string;
    systemPrompt: string;
    /** Optional model override for the spawned minion. */
    model?: string;
    thinkingConfig?: ThinkingConfig;
    /**
     * Optional override for the spawned minion's AgentHarness. When omitted,
     * the leader-side wrapper in `SessionHost.buildAgentContext` defaults it
     * to the leader's current `harnessName`.
     */
    harness?: string;
    permissionMode?: string;
    executorClass?: "mechanical" | "standard" | "reasoning";
    skillIds?: string[];
    onAllocated?: (sessionKey: string) => void;
  }) => void | Promise<{ sessionKey: string; harness: string; model: string; permissionMode: string }>;
  cwd: string;
  /**
   * The canonical project path (sidecar root). When the leader is running
   * inside a git worktree, `cwd` points at the worktree but `projectPath`
   * still points at the original checkout where `.minions/skills.json`
   * lives. Falls back to `cwd` when no worktree is in use.
   */
  projectPath: string;
  minionSystemPrompt: string;
  /**
   * Skills selected when the Leader was launched. Every delegated Minion
   * inherits these; assign_task.skillIds may add task-specific skills.
   */
  defaultMinionSkillIds?: readonly string[];
  /** Configured values for the inherited Leader-selected skills. */
  defaultMinionSkillValues?: Record<string, Record<string, string>>;
  /**
   * Loaded system model when the layer is active (advisory/enforced), else
   * null. Powers the deterministic packet-required trigger in plan_task /
   * assign_task (redesign §5). Null when the layer is off.
   */
  systemModel?: LoadedSystemModel | null;
  taskState: TaskManagerState;
  /** Latest full connected-canvas context snapshot for this leader, if any. */
  getCanvasContext?: () => string | null;
  getSessionRuntime?: (sessionKey: string) => RuntimeSessionInfo | null;
  onStateChange?: (state: TaskManagerState) => void;
  worktreeBranch?: string | null;
  worktreeInfo?: WorktreeInfo | null;
  worktreeIsolation?: boolean;
  scheduleWaitContinue: (durationMs: number, reason: string) => ReturnType<typeof setTimeout> | null | void;
  terminateSession?: (sessionKey: string, reason: "abort") => void;
  /**
   * Inject a steering message into a live minion session as a new user turn.
   * Returns whether the message was delivered and the session's status so the
   * caller can report a useful error for non-live (ended) sessions.
   */
  messageSession?: (
    sessionKey: string,
    message: string,
  ) => { delivered: boolean; status: string | null };
  taskTimeoutMs?: number;
  /** Live dashboard snapshot used to block checkpoints with pending forms. */
  getRenderComponents?: () => RenderComponent[];
}
