/**
 * Shared types for the WebSocket command dispatcher.
 *
 * Extracted from `server/index.ts` in Phase 5.2. The command table itself
 * lives in `server/commands/index.ts`; each handler is its own module.
 */

import type { WebSocket } from "ws";
import type { Bus } from "../bus.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRole } from "../session-host.ts";
import type { RoutineRunRegistry } from "../routine-registry.ts";

/** Every WebSocket command recognised by the server. */
export type WsCommandType =
  // Session lifecycle
  | "create_session"
  | "send_message"
  | "stop_session"
  | "sync_session"
  | "list_sessions"
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
  | "get_supported_models"
  | "get_supported_commands"
  | "get_supported_agents"
  | "get_account_info"
  | "get_mcp_server_status"
  // MCP server control
  | "reconnect_mcp_server"
  | "toggle_mcp_server"
  // Routines
  | "list_routines"
  | "start_routine"
  | "abort_routine"
  // Render-DSL interactive components
  | "submit_form"
  // Session history
  | "clear_session";

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

/** The full WebSocket command envelope clients send. */
export interface WsCommand {
  type: WsCommandType;
  sessionKey?: string;
  prompt?: string;
  /** Multimodal attachments that accompany `prompt` on the first user turn. */
  attachments?: WsImageAttachment[];
  cwd?: string;
  permissionMode?: string;
  systemPrompt?: string;
  role?: SessionRole;
  worktreeIsolation?: boolean;
  // Configuration params
  model?: string;
  /** Adaptive-thinking config — may be updated on every send_message */
  thinkingConfig?: unknown;
  projectPath?: string;
  // Task control params
  taskId?: string;
  // Rewind params
  userMessageId?: string;
  dryRun?: boolean;
  // Seed read state params
  path?: string;
  mtime?: number;
  // MCP server params
  serverName?: string;
  enabled?: boolean;
  // Routine params
  routineId?: string;
  runId?: string;
  routineInputs?: Record<string, unknown>;
  // Render-DSL interactive submit_form command params
  formComponentId?: string;
  formAnswers?: Record<string, unknown>;
  // Request ID for correlating async responses
  requestId?: string;
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
  /**
   * Live routine-run tracker. Only the routines/* command handlers use it;
   * everything else can ignore it.
   */
  routines: RoutineRunRegistry;
}

/** A command handler takes context + command + the originating socket. */
export type CommandHandler = (
  ctx: CommandContext,
  cmd: WsCommand,
  ws: WebSocket,
) => void;

/** Registry shape: every WsCommandType maps to a handler. */
export type CommandTable = Readonly<Record<WsCommandType, CommandHandler>>;
