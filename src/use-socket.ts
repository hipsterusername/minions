import { useEffect, useRef, useState, useCallback } from "react";
import { getAuthToken, clearAuthToken } from "./api.ts";

export type ServerMessage =
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "session_created"; sessionKey: string }
  | { type: "session_status"; sessionKey: string; status: string; sessionId?: string }
  | { type: "session_error"; sessionKey: string; error: string }
  | { type: "sdk_event"; sessionKey: string; message: SdkMessage }
  | { type: "sync_response"; sessionKey: string; found: boolean; status?: string; sessionId?: string; totalCost?: number; turns?: number; lastError?: string | null; events?: SyncEvent[]; model?: string; permissionMode?: string; initData?: Record<string, unknown>; taskName?: string | null; role?: "leader" | "minion" | "default"; activeMinions?: ActiveMinion[] }
  | { type: "control_response"; command: string; sessionKey: string; requestId: string | null; success: boolean; error?: string; [key: string]: unknown }
  | { type: "session_task_name"; sessionKey: string; taskName: string }
  | { type: "error"; message: string };

export interface SyncEvent {
  type: string;
  sessionKey: string;
  message?: SdkMessage;
  status?: string;
  error?: string;
  timestamp: number;
}

export interface SessionInfo {
  sessionKey: string;
  sessionId: string | null;
  status: string;
  cwd: string;
  totalCost?: number;
  turns?: number;
  model?: string | null;
  permissionMode?: string | null;
  taskName?: string | null;
  role?: "leader" | "minion" | "default";
  activeMinions?: ActiveMinion[];
}

export interface ActiveMinion {
  taskId: string;
  title: string;
  status: string;
  sessionKey: string | null;
}

// ── Content Block Types ────────────────────────────────
// Matches Anthropic API BetaMessage content blocks as serialized over JSON

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ServerToolResultBlock {
  type: "server_tool_result";
  tool_use_id: string;
  content: ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ServerToolUseBlock
  | ServerToolResultBlock;

// ── Usage types ────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
  utilization?: number;
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export type FastModeState = "off" | "cooldown" | "on";

export type AssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

// ── SDK Message Types (discriminated union) ────────────
// These mirror the SDK's SDKMessage union, serialized over WebSocket JSON.
// Discriminated on `type` (and `subtype` for system messages).

// ── System messages (type: "system", discriminated by subtype) ──

/** Session initialization — first event after query() starts */
export interface SdkInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  claude_code_version: string;
  cwd: string;
  tools: string[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
  mcp_servers: { name: string; status: string }[];
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
  agents?: string[];
  betas?: string[];
  fast_mode_state?: FastModeState;
  uuid: string;
}

/** Status update (e.g. compacting context) */
export interface SdkStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}

/** API retry notification */
export interface SdkApiRetryMessage {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: AssistantMessageError;
  uuid: string;
  session_id: string;
}

/** Local slash-command output (e.g. /cost, /voice) */
export interface SdkLocalCommandOutputMessage {
  type: "system";
  subtype: "local_command_output";
  content: string;
  uuid: string;
  session_id: string;
}

/** Context compaction boundary marker */
export interface SdkCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    preserved_segment?: {
      head_uuid: string;
      anchor_uuid: string;
      tail_uuid: string;
    };
  };
  uuid: string;
  session_id: string;
}

/** Session state changed (idle/running/requires_action) */
export interface SdkSessionStateChangedMessage {
  type: "system";
  subtype: "session_state_changed";
  state: "idle" | "running" | "requires_action";
  uuid: string;
  session_id: string;
}

/** Files persisted to storage */
export interface SdkFilesPersistedMessage {
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
  uuid: string;
  session_id: string;
}

/** MCP elicitation completed */
export interface SdkElicitationCompleteMessage {
  type: "system";
  subtype: "elicitation_complete";
  mcp_server_name: string;
  elicitation_id: string;
  uuid: string;
  session_id: string;
}

/** Hook execution started */
export interface SdkHookStartedMessage {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

/** Hook progress output */
export interface SdkHookProgressMessage {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: string;
  session_id: string;
}

/** Hook completed */
export interface SdkHookResponseMessage {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  uuid: string;
  session_id: string;
}

/** Subagent task started */
export interface SdkTaskStartedMessage {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  uuid: string;
  session_id: string;
}

/** Subagent task progress */
export interface SdkTaskProgressMessage {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  summary?: string;
  uuid: string;
  session_id: string;
}

/** Subagent task completed/failed/stopped */
export interface SdkTaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  uuid: string;
  session_id: string;
}

/** Union of all system-subtype messages */
export type SdkSystemMessage =
  | SdkInitMessage
  | SdkStatusMessage
  | SdkApiRetryMessage
  | SdkLocalCommandOutputMessage
  | SdkCompactBoundaryMessage
  | SdkSessionStateChangedMessage
  | SdkFilesPersistedMessage
  | SdkElicitationCompleteMessage
  | SdkHookStartedMessage
  | SdkHookProgressMessage
  | SdkHookResponseMessage
  | SdkTaskStartedMessage
  | SdkTaskProgressMessage
  | SdkTaskNotificationMessage;

// ── Non-system messages ────────────────────────────────

/** Full assistant response from Claude */
export interface SdkAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string | null;
    usage: TokenUsage;
  };
  parent_tool_use_id: string | null;
  error?: AssistantMessageError;
  uuid: string;
  session_id: string;
}

/** Streaming chunk from Claude API */
export interface SdkPartialAssistantMessage {
  type: "stream_event";
  event: Record<string, unknown>; // BetaRawMessageStreamEvent — varies widely
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

/** User message (sent or replayed) */
export interface SdkUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  isReplay?: boolean;
  tool_use_result?: unknown;
  priority?: "now" | "next" | "later";
  timestamp?: string;
  uuid?: string;
  session_id?: string;
}

/** Successful result */
export interface SdkResultSuccess {
  type: "result";
  subtype: "success";
  result: string;
  is_error: false;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: TokenUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: PermissionDenial[];
  structured_output?: unknown;
  fast_mode_state?: FastModeState;
  uuid: string;
  session_id: string;
}

/** Error result */
export interface SdkResultError {
  type: "result";
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: true;
  errors: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: TokenUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: PermissionDenial[];
  fast_mode_state?: FastModeState;
  uuid: string;
  session_id: string;
}

export type SdkResultMessage = SdkResultSuccess | SdkResultError;

/** Tool execution progress */
export interface SdkToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
  uuid: string;
  session_id: string;
}

/** Tool use summary (collapsed tool group) */
export interface SdkToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

/** Authentication status */
export interface SdkAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

/** Rate limit event */
export interface SdkRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: RateLimitInfo;
  uuid: string;
  session_id: string;
}

/** AI-predicted next user prompt */
export interface SdkPromptSuggestionMessage {
  type: "prompt_suggestion";
  suggestion: string;
  uuid: string;
  session_id: string;
}

// ── Master SDK Message Union ───────────────────────────
// All 23 SDK message types, matching the SDK's SDKMessage exactly.

export type SdkMessage =
  // System messages (14 subtypes)
  | SdkInitMessage
  | SdkStatusMessage
  | SdkApiRetryMessage
  | SdkLocalCommandOutputMessage
  | SdkCompactBoundaryMessage
  | SdkSessionStateChangedMessage
  | SdkFilesPersistedMessage
  | SdkElicitationCompleteMessage
  | SdkHookStartedMessage
  | SdkHookProgressMessage
  | SdkHookResponseMessage
  | SdkTaskStartedMessage
  | SdkTaskProgressMessage
  | SdkTaskNotificationMessage
  // Non-system messages (9 types)
  | SdkAssistantMessage
  | SdkPartialAssistantMessage
  | SdkUserMessage
  | SdkResultSuccess
  | SdkResultError
  | SdkToolProgressMessage
  | SdkToolUseSummaryMessage
  | SdkAuthStatusMessage
  | SdkRateLimitEvent
  | SdkPromptSuggestionMessage;

// ── Type guards ────────────────────────────────────────

export function isSystemMessage(msg: SdkMessage): msg is SdkSystemMessage {
  return msg.type === "system";
}

export function isAssistantMessage(msg: SdkMessage): msg is SdkAssistantMessage {
  return msg.type === "assistant";
}

export function isResultMessage(msg: SdkMessage): msg is SdkResultMessage {
  return msg.type === "result";
}

export function isResultSuccess(msg: SdkMessage): msg is SdkResultSuccess {
  return msg.type === "result" && "subtype" in msg && msg.subtype === "success";
}

export function isResultError(msg: SdkMessage): msg is SdkResultError {
  return msg.type === "result" && "subtype" in msg && msg.subtype !== "success";
}

export function isToolProgress(msg: SdkMessage): msg is SdkToolProgressMessage {
  return msg.type === "tool_progress";
}

export function isStreamEvent(msg: SdkMessage): msg is SdkPartialAssistantMessage {
  return msg.type === "stream_event";
}

export function isRateLimitEvent(msg: SdkMessage): msg is SdkRateLimitEvent {
  return msg.type === "rate_limit_event";
}

export function isUserMessage(msg: SdkMessage): msg is SdkUserMessage {
  return msg.type === "user";
}

export function isToolUseSummary(msg: SdkMessage): msg is SdkToolUseSummaryMessage {
  return msg.type === "tool_use_summary";
}

export function isAuthStatus(msg: SdkMessage): msg is SdkAuthStatusMessage {
  return msg.type === "auth_status";
}

export function isPromptSuggestion(msg: SdkMessage): msg is SdkPromptSuggestionMessage {
  return msg.type === "prompt_suggestion";
}

/** Narrow a system message by subtype */
export function isSystemSubtype<S extends SdkSystemMessage["subtype"]>(
  msg: SdkMessage,
  subtype: S,
): msg is Extract<SdkSystemMessage, { subtype: S }> {
  return msg.type === "system" && "subtype" in msg && (msg as SdkSystemMessage).subtype === subtype;
}

type Listener = (msg: ServerMessage) => void;

export type ReconnectState = "connected" | "reconnecting" | "failed";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const JITTER_MS = 500;

/** Compute exponential backoff delay with jitter: 2s → 4s → 8s → 16s … capped at 30s, ±500ms jitter */
function getBackoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = (Math.random() * 2 - 1) * JITTER_MS; // random in [-500, +500]
  return Math.max(0, exponential + jitter);
}

interface SocketHandle {
  connected: boolean;
  reconnectState: ReconnectState;
  reconnectAttempt: number;
  manualReconnect: () => void;
  send: (data: unknown) => void;
  subscribe: (fn: Listener) => () => void;
}

/** Known server message types — reject anything not in this set */
const KNOWN_SERVER_MESSAGE_TYPES = new Set([
  "session_list",
  "session_created",
  "session_status",
  "session_error",
  "sdk_event",
  "sync_response",
  "control_response",
  "session_task_name",
  "error",
  // Canvas-specific broadcast events
  "worktree_created",
  "worktree_failed",
  "worktree_merged",
  "worktree_merge_failed",
  "worktree_removed",
  "approval_requested",
  "approval_resolved",
  "minion_spawned",
  "minion_completed",
  "task_plan_update",
  "agent_spawned",
  "agent_task_update",
  "wait_state",
  "task_planned",
  "task_assigned",
  "task_completed",
  "task_failed",
  "task_name_set",
  "render_dashboard",
]);

function isValidServerMessage(data: unknown): data is ServerMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  return KNOWN_SERVER_MESSAGE_TYPES.has(obj.type);
}

export function useSocket(url: string): SocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<Listener>>(new Set());
  const [connected, setConnected] = useState(false);
  const [reconnectState, setReconnectState] = useState<ReconnectState>("reconnecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Fetch the auth token, then connect with it as a query param
    void getAuthToken().then((token) => {
      // Re-check after async gap
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const separator = url.includes("?") ? "&" : "?";
      const authedUrl = `${url}${separator}token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(authedUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnectState("connected");
        attemptRef.current = 0;
        setReconnectAttempt(0);
      };

      ws.onclose = () => {
        setConnected(false);
        // Clear cached auth token so the next reconnect fetches a fresh one
        // (the server generates a new token on every restart)
        clearAuthToken();
        const nextAttempt = attemptRef.current + 1;
        attemptRef.current = nextAttempt;
        setReconnectAttempt(nextAttempt);

        if (nextAttempt >= MAX_RECONNECT_ATTEMPTS) {
          setReconnectState("failed");
          return; // stop auto-retrying
        }

        setReconnectState("reconnecting");
        const delay = getBackoffDelay(nextAttempt - 1);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const parsed: unknown = JSON.parse(String(ev.data));
          if (!isValidServerMessage(parsed)) {
            console.warn("[ws] Rejected message with unknown type:", (parsed as Record<string, unknown>)?.type);
            return;
          }
          for (const fn of listenersRef.current) {
            fn(parsed);
          }
        } catch {
          // ignore malformed messages
        }
      };
    });
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const manualReconnect = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    attemptRef.current = 0;
    setReconnectAttempt(0);
    setReconnectState("reconnecting");
    clearAuthToken();
    // Close any existing socket before reconnecting
    if (wsRef.current) {
      // Prevent the onclose handler from scheduling its own reconnect
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  return { connected, reconnectState, reconnectAttempt, manualReconnect, send, subscribe };
}
