/**
 * Type definitions and defaults for the Leader node.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` so other modules that only need
 * the shape (Canvas, KanbanBoard, leader-preset, etc.) can import without
 * pulling the full renderer.
 */

import type { ThinkingConfig } from "../../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../../types.ts";
import type { ContextDeliveryLedger } from "../../context-delivery.ts";
import type { PermissionMode } from "../../components/SessionToolbar.tsx";
import type { DisplayMessage } from "../../sdk-messages.ts";
import type { RenderState } from "../../../shared/render-dsl.ts";
import { emptyRenderState } from "../../../shared/render-dsl.ts";
import type { WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import type { LiveEditAwareness } from "../../../shared/live-edit-coordination.ts";

/**
 * Zoom level below which the leader prompt overlay (zoomed-in prompt editor)
 * is suppressed. Kept here so non-renderer consumers can reference it without
 * dragging in the leader's React tree.
 */
export const LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD = 0.55;

/** A single entry in the leader's task plan. Covers all states. */
export interface TaskPlanItem {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  /** planned → running → completed | failed; blocked = awaiting leader input */
  status:
    | "planned"
    | "starting"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "ended_without_report"
    | "cancelled"
    | "orphaned";
  /** Who is/was executing this task */
  executor: "leader" | "minion";
  minionSessionKey: string | null;
  result: string | null;
  /** Cost in USD — populated for minion tasks on completion */
  cost: number;
  createdAt: number;
  completedAt: number | null;
  /** Last few assistant messages from the minion session (tooltip detail) */
  sessionSummary: string;
  /** Latest live progress report from a delegated minion. */
  activeStep?: string | null | undefined;
  /** Recent progress reports from a delegated minion. */
  progress?: string[] | undefined;
}

export interface LeaderData {
  /** Durable lifecycle identity. `sessionKey` remains a legacy run alias. */
  workItemId?: string | null;
  currentRunKey?: string | null;
  /** Read-only canonical server snapshot used by shared presentation selectors. */
  workItemSnapshot?: WorkItemSnapshot | null;
  liveEditAwareness?: LiveEditAwareness;
  sessionKey: string | null;
  status: "disconnected" | "creating" | "running" | "idle" | "stopped" | "error" | "completed";
  messages: LeaderMessage[];
  /** Accumulated partial text from streaming deltas */
  streamingText: string;
  /**
   * Anthropic content block index that {@link streamingText} belongs to,
   * or `null` when no block is currently streaming. Used to flush the
   * preview buffer when a new content block starts so deltas from
   * `[text, tool_use, text]` don't merge across blocks.
   */
  streamingBlockIndex?: number | null | undefined;
  totalCost: number;
  turns: number;
  error: string | null;
  fullError?: string | null | undefined;
  model: string;
  permissionMode: PermissionMode;
  /** Active harness driving this session (e.g. "claude", "echo", "codex"). */
  harness?: string;
  /** Adaptive-thinking config sent to the SDK on every query() call. */
  thinkingConfig: ThinkingConfig;
  taskPlan: TaskPlanItem[];
  worktreeIsolation: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeStatus: "none" | "creating" | "active" | "merging" | "merged" | "discarded" | "failed";
  /** IDs of skills tagged onto this leader */
  skillIds: string[];
  /** Variable values for each skill: { [skillId]: { [varName]: value } } */
  skillValues: Record<string, Record<string, string>>;
  /** Whether the skill config panel is expanded */
  skillPanelOpen: boolean;
  /** Optional text prepended to the generated Leader system prompt. */
  systemPromptPrefix?: string | null | undefined;
  /** If set, auto-start a session with this prompt (then clear it) */
  autoStartPrompt?: string | null | undefined;
  /** If set, pre-fill the prompt input once (then clear it) */
  draftPrompt?: string | null | undefined;
  /** Display name set by the agent via set_task_name */
  taskName?: string | null | undefined;
  /** Wait state: populated when the leader calls wait_and_continue */
  waitUntil?: number | null | undefined;
  waitReason?: string | null | undefined;
  /** Set briefly after a successful merge to show a confirmation banner */
  mergeConfirmed?: boolean | undefined;
  /** Merge conflict state: set when approve & merge fails due to conflicts */
  mergeConflict?: {
    conflicts: string[];
    summary: string;
    targetBranch: string;
  } | null | undefined;
  /** Approval state: set when the leader calls request_approval */
  approvalPending?: boolean | undefined;
  approvalSummary?: string | null | undefined;
  approvalDiff?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: { file: string; insertions: number; deletions: number; status: string }[];
    commits: string[];
    branch: string;
  } | null | undefined;
  /**
   * Live agent-driven dashboard state, populated from `render_update` events on
   * this leader's session topic. Rendered inside the leader body (embedded
   * dashboard) — this replaces the retired standalone `render` node.
   *
   * Optional so the many `LeaderData` construction sites (clone, presets,
   * Kanban) don't all need to seed it; read sites fall back to
   * `emptyRenderState()`.
   */
  renderState?: RenderState | undefined;
  /**
   * Which body pane is foregrounded when the node is too narrow for a split
   * view. Chat-forward by default (see progressive-disclosure in `LeaderBody`).
   */
  activeBodyView?: "chat" | "dashboard" | undefined;
  /** Persisted split ratio (0–1) for the chat｜dashboard divider when wide. */
  dashboardSplitRatio?: number | undefined;
  /**
   * Per-source connected-context delivery ledger: what this session has
   * already received from each upstream context node (`src/context-delivery.ts`).
   * Persisted with the node so reloads don't re-send unchanged context, and
   * read by the edge-staleness UI (`src/context-staleness.ts`).
   */
  contextDelivery?: ContextDeliveryLedger | undefined;
}

/**
 * LeaderMessage is an alias for the shared DisplayMessage type used by both
 * leader and minion sessions.
 */
export type LeaderMessage = DisplayMessage;

/** Selection state for picking individual chunks out of a single message. */
export interface MessageContextSelection {
  messageId: string;
  selectedChunkIds: string[];
  anchorChunkId: string | null;
}

/** Default-initialized {@link LeaderData} used when creating a fresh leader node. */
export const LEADER_DEFAULT_DATA: LeaderData = {
  sessionKey: null,
  status: "disconnected",
  messages: [],
  streamingText: "",
  streamingBlockIndex: null,
  totalCost: 0,
  turns: 0,
  error: null,
  fullError: null,
  model: "opus",
  permissionMode: "auto",
  thinkingConfig: { ...DEFAULT_THINKING_CONFIG },
  taskPlan: [],
  worktreeIsolation: false,
  worktreePath: null,
  worktreeBranch: null,
  worktreeStatus: "none",
  skillIds: [],
  skillValues: {},
  skillPanelOpen: false,
  waitUntil: null,
  waitReason: null,
  renderState: emptyRenderState(),
};
