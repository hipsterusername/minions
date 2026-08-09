/**
 * Shared types for the WebSocket command dispatcher.
 *
 * The command table lives in `server/commands/index.ts`; each handler is
 * its own module.
 */

import type { WebSocket } from "ws";
import type { Bus } from "../bus.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRole } from "../session-host.ts";
import type { SessionLaunchResult } from "../session-launch.ts";
import type { StartSessionOptions } from "../session-host.ts";
import type { WorkItemService } from "../work-item-service.ts";
import type { ChangeMode } from "../../shared/work-item-lifecycle.ts";
import type { WorkItemBindingSurface } from "../../shared/work-item-contracts.ts";
import type { LiveEditAwareness } from "../../shared/live-edit-coordination.ts";
import type { WorktreeIntegrationService } from "../worktree-integration-service.ts";

/** Every WebSocket command recognised by the server. */
export type WsCommandType =
  // Session lifecycle
  | "create_session"
  | "send_message"
  | "canvas_context"
  | "stop_session"
  | "sync_session"
  | "list_sessions"
  | "list_harnesses"
  | "acknowledge_session"
  | "dismiss_session"
  | "reopen_session"
  // Durable work items
  | "create_work_item"
  | "continue_work_item"
  | "start_work_item_run"
  | "reply_to_waiting_run"
  | "review_work_item"
  | "archive_work_item"
  | "restore_work_item"
  | "attach_work_item_surface"
  | "detach_work_item_surface"
  | "get_work_item"
  | "list_work_items"
  | "get_work_item_runs"
  | "create_worktree_lineage" | "join_worktree_lineage"
  | "review_worktree_contribution" | "enqueue_worktree_contribution"
  | "retry_worktree_contribution" | "discard_worktree_contribution"
  | "review_worktree_lineage" | "waive_worktree_integration_gate"
  | "resolve_worktree_conflict" | "promote_worktree_lineage" | "get_worktree_lineage_status"
  | "list_worktree_lineages"
  // Execution control
  | "interrupt"
  | "interrupt_session"
  | "close_session"
  // Configuration control
  | "set_permission_mode"
  | "set_model"
  // Task control
  | "stop_task"
  // Worktree control
  | "merge_worktree"
  | "discard_worktree"
  | "get_worktree_diff"
  | "approve_changes"
  | "force_merge"
  | "theirs_merge"
  | "retry_merge"
  | "remove_session"
  // File & state control
  | "rewind_files"
  | "seed_read_state"
  // Info queries
  | "get_context_usage"
  | "get_usage_report"
  | "get_provider_usage_report"
  | "get_supported_models"
  | "get_supported_commands"
  | "get_supported_agents"
  | "get_account_info"
  | "get_mcp_server_status"
  | "get_system_model_status"
  | "get_system_graph"
  | "get_work_packets"
  | "waive_review_gate"
  // MCP server control
  | "reconnect_mcp_server"
  | "toggle_mcp_server"
  // Render-DSL interactive components
  | "submit_form"
  // Session history
  | "clear_session"
  // Dialectic dual-planner (experimental)
  | "start_dialectic"
  | "stop_dialectic";

/**
 * Binary attachment the client pins to a user turn — today only images.
 * The server converts these into SDK {@link ImageBlockParam} blocks so
 * the model actually sees the pixels, not just a text description.
 */
export interface WsImageAttachment {
  kind: "image";
  filename?: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Raw base64 payload, no `data:...;base64,` prefix. */
  data: string;
}

export interface WsCanvasContextItem {
  nodeId: string;
  nodeType: string;
  label: string;
  content: string;
  attachments?: WsImageAttachment[];
}

/** The full WebSocket command envelope clients send. */
export interface WsCommand {
  type: WsCommandType;
  sessionKey?: string;
  /** Durable leader/work-item identity for additive lifecycle migration. */
  workItemId?: string;
  runKey?: string;
  prompt?: string;
  /** User-authored text to record in the visible transcript before this prompt runs. */
  displayPrompt?: string;
  /** Multimodal attachments that accompany `prompt` on the first user turn. */
  attachments?: WsImageAttachment[];
  /** Full connected-canvas context snapshot for `canvas_context`. */
  items?: WsCanvasContextItem[];
  cwd?: string;
  permissionMode?: string;
  systemPrompt?: string;
  role?: SessionRole;
  /** Skill IDs tagged on a leader session; gate opt-in tools. */
  skillIds?: string[];
  /** Template values configured for tagged skills. */
  skillValues?: Record<string, Record<string, string>>;
  worktreeIsolation?: boolean;
  // Configuration params
  model?: string;
  /** Adaptive-thinking config — may be updated on every send_message */
  thinkingConfig?: unknown;
  /**
   * Dialectic run configuration (start_dialectic). Loosely typed here; the
   * handler normalizes it via `normalizeDialecticConfig` in shared/dialectic.
   */
  dialecticConfig?: unknown;
  projectPath?: string;
  projectId?: string;
  title?: string;
  changeMode?: ChangeMode;
  surface?: WorkItemBindingSurface;
  bindingId?: string;
  includeArchived?: boolean;
  cursor?: string;
  limit?: number;
  workPacketId?: string;
  gateId?: string;
  reason?: string;
  taskId?: string;
  userMessageId?: string;
  dryRun?: boolean;
  path?: string;
  mtime?: number;
  serverName?: string;
  enabled?: boolean;
  runId?: string;
  // Render-DSL interactive submit_form command params
  formComponentId?: string;
  formAnswers?: Record<string, unknown>;
  // Request ID for correlating async responses
  requestId?: string;
  /** Compare-and-set guard for durable Activity lifecycle mutations. */
  expectedLifecycleRevision?: number;
  /** Compare-and-set guard paired with lifecycle revision. */
  expectedCurrentRunKey?: string | null;
  /**
   * Name of the registered AgentHarness to drive this session.
   * Honoured only by `create_session`; mid-thread switches via `send_message`
   * are intentionally ignored — the host's existing `harnessName` wins so a
   * Claude conversation cannot silently flip into Codex (or vice versa) on a
   * follow-up turn.
   */
  harness?: string;
  lineageId?: string;
  contributionId?: string;
  targetBranch?: string;
  expectedIntegrationRevision?: number;
  summary?: string;
  gates?: Array<{ id: string; state: "passed" | "failed" | "waived"; detail?: string }>;
  decision?: "approved" | "rejected";
  actor?: string;
  strategy?: "manual" | "ours" | "theirs";
  queueId?: string;
  integrationScope?: "contribution" | "lineage";
}

/**
 * Shared services available to every command handler. Constructed once in
 * `server/index.ts` and passed into the dispatcher — handlers stay pure
 * functions that take `(ctx, cmd, ws)` and either return or fire events on
 * the bus.
 */
export interface CommandContext {
  registry: SessionRegistry;
  bus: Bus;
  /** Generate a fresh sessionKey when the client doesn't supply one. */
  generateKey: () => string;
  /** Upper bound on simultaneous sessions. */
  maxSessions: number;
  launchSession: (options: StartSessionOptions) => Promise<SessionLaunchResult>;
  workItems?: WorkItemService;
  worktreeIntegrations?: WorktreeIntegrationService;
  getLiveEditAwareness?: (projectPath: string, workItemIds: readonly string[]) => Record<string, LiveEditAwareness>;
  /** Canonical registered-path/project ownership seam. */
  resolveWorkItemProject?: (projectId: string, projectPath: string) => string | null;
}

/** A command handler takes context + command + the originating socket. */
export type CommandHandler = (
  ctx: CommandContext,
  cmd: WsCommand,
  ws: WebSocket,
) => void | Promise<void>;

/** Registry shape: every WsCommandType maps to a handler. */
export type CommandTable = Readonly<Record<WsCommandType, CommandHandler>>;
