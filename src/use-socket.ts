import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { getAuthToken, clearAuthToken } from "./api.ts";
import {
  normalizedEventEnvelopeSchema,
  wsEnvelopeSchema,
  topicMatches,
  type WsEnvelope,
} from "../shared/ws-envelope.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { RenderState } from "../shared/render-dsl.ts";
import type { WorkItemListSnapshot, WorkItemRunListSnapshot, WorkItemRunSnapshot, WorkItemSnapshot } from "../shared/work-item-contracts.ts";
import type { LiveEditCoordinationEvent } from "../shared/live-edit-coordination.ts";
import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";
import type { SandboxResolution } from "../shared/workspace-contracts.ts";
import { browserLogger } from "./logging.ts";

const log = browserLogger.child("websocket");

export type ServerMessage =
  | { type: "live_edit_coordination"; workItemId: string; event: LiveEditCoordinationEvent; timestamp: number }
  | { type: "work_item_response"; command: string; requestId: string | null; success: boolean; result?: WorkItemListSnapshot | WorkItemRunListSnapshot | unknown; error?: string; code?: string; latest?: unknown }
  | { type: "worktree_integration_response"; command: string; requestId: string | null;
      success: boolean; result?: WorktreeLineageSnapshot | null; error?: string; code?: string;
      latest?: WorktreeLineageSnapshot | null }
  | { type: "worktree_integration_changed"; operation: string; workItemId: string | null;
      lineage: WorktreeLineageSnapshot; timestamp: number }
  | { type: "worktree_lineages_list"; requestId: string | null;
      lineages: WorktreeLineageSnapshot[]; error?: string }
  | { type: "work_item_changed"; workItem: WorkItemSnapshot; revision: number; cause: string; timestamp: number }
  | { type: "work_item_created"; workItem: WorkItemSnapshot; timestamp: number }
  | { type: "work_item_run_created" | "work_item_run_sealed"; workItemId: string; run: WorkItemRunSnapshot; timestamp: number }
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "harness_list"; harnesses: HarnessListEntry[] }
  | { type: "session_created"; sessionKey: string }
  | { type: "session_launch_resolved"; sessionKey: string; requested: { harness?: string; model?: string; permissionMode?: string }; effective: { harness: string; model: string; permissionMode: string }; reasons: Array<"harness_not_ready" | "model_incompatible" | "permission_unsupported">; transient: true }
  | { type: "session_status"; sessionKey: string; status: string; sessionId?: string }
  | { type: "session_compacted"; sessionKey: string; checkpointId?: string; trigger?: "proactive" | "context_recovery"; oldSessionId: string | null; newSessionId: string | null; contextTokensBefore?: number; contextWindowTokens?: number; ratioBefore?: number; timestamp: number }
  | { type: "session_error"; sessionKey: string; error: string; fullError?: string }
  | { type: "sdk_event"; sessionKey: string; runKey?: string; workItemId?: string | null; event: NormalizedEvent; timestamp?: number }
  | { type: "sync_response"; sessionKey: string; runKey?: string; workItemId?: string | null; runKind?: "primary" | "child"; parentRunKey?: string | null; taskId?: string | null; found: boolean; status?: string; sessionId?: string | null; cwd?: string; totalCost?: number; turns?: number; usageTotals?: SessionUsageTotals; lastError?: string | null; lastErrorFull?: string | null; events?: SyncEvent[]; model?: string | null; permissionMode?: string | null; sandboxPolicy?: SandboxResolution | null; initData?: Record<string, unknown>; taskName?: string | null; role?: "leader" | "minion" | "default"; activeMinions?: ActiveMinion[]; taskPlan?: SyncTaskRecord[]; renderState?: RenderState | null; worktree?: { path: string; branch: string } | null; approval?: { requested?: boolean; summary?: string; diff?: unknown; graceUntil?: number } | null; harness?: string; harnessCapabilities?: HarnessCapabilities | null; reviewLifecycle?: SessionReviewLifecycle }
  | { type: "control_response"; command: string; sessionKey: string | null; requestId: string | null; success: boolean; error?: string; [key: string]: unknown }
  | { type: "session_cleared"; sessionKey: string }
  | { type: "session_task_name"; sessionKey: string; taskName: string }
  | { type: "approval_requested"; sessionKey: string; summary: string; diff: unknown; timestamp: number; graceUntil?: number }
  | { type: "approval_resolved"; sessionKey: string; action: string; timestamp: number }
  | { type: "worktree_status"; sessionKey: string; status: string; path?: string; branch?: string }
  | { type: "worktree_created"; sessionKey: string; worktreePath: string; branch: string }
  | { type: "worktree_failed"; sessionKey: string; error: string }
  | { type: "worktree_removed"; sessionKey: string; timestamp: number }
  | { type: "worktree_merged"; sessionKey: string }
  | { type: "worktree_merge_failed"; sessionKey: string; result?: { conflicts?: string[]; summary?: string; targetBranch?: string }; error?: string }
  | { type: "session_completed"; sessionKey: string; reason: string; timestamp: number }
  | { type: "session_lifecycle_changed"; sessionKey: string; lifecycle: SessionReviewLifecycle; timestamp: number }
  | { type: "minion_status"; minionSessionKey: string; trigger: "step" | "done" | "fail"; message: string; timestamp: number; leaderSessionKey?: string; taskId?: string }
  | { type: "minion_completed"; leaderSessionKey: string; minionSessionKey: string; taskId: string; status: "completed" | "failed"; result: string; timestamp: number }
  | { type: "agent_task_update"; leaderSessionKey: string; taskId: string; status: string; summary?: string; timestamp: number }
  | { type: "task_plan_update"; leaderSessionKey: string; tasks: SyncTaskRecord[] }
  | { type: "render_update"; leaderSessionKey: string; action: "set" | "patch" | "append" | "remove"; layout?: { title?: string | null; columns?: number; gap?: number; components?: unknown[] }; updates?: unknown[]; components?: unknown[]; ids?: string[] }
  | { type: "wait_state"; sessionKey: string; action: string; reason: string; waitUntil?: number; scheduledAt?: number; durationMs?: number; timestamp?: number }
  | { type: "error"; message: string };

export interface SyncEvent {
  type: string;
  sessionKey: string;
  /** Canonical identity fields are absent on older replayed events. */
  runKey?: string;
  workItemId?: string | null;
  event?: NormalizedEvent;
  /** @deprecated legacy test compat only — new writes use `event` */
  message?: unknown;
  status?: string;
  error?: string;
  fullError?: string;
  checkpointId?: string;
  trigger?: "proactive" | "context_recovery";
  timestamp: number;
}

/**
 * Capability flags declared by an `AgentHarness` and surfaced to the client
 * via `sync_response` and `session_list`. Mirrors `server/harness/types.ts`
 * `HarnessCapabilities` — keep the two in sync.
 */
export interface HarnessCapabilities {
  mutationInterception: "complete" | "observe_only" | "none";
  thinking: boolean;
  promptCaching: boolean;
  mcp: boolean;
  permissionPrompts: boolean;
  resume: boolean;
  partialMessages: boolean;
  builtInFilesystem: boolean;
  sandboxEnforcement?: {
    filesystem: ReadonlyArray<"read-only" | "workspace-write" | "unrestricted">;
    approval: boolean;
  };
}

/**
 * A single entry in the `harness_list` server payload. Mirrors what
 * `server/commands/list-harnesses.ts` emits — keep the two in sync.
 */
export interface HarnessListEntry {
  name: string;
  capabilities: HarnessCapabilities;
  builtInTools: string[];
  models: ReadonlyArray<{ id: string; label: string }>;
  commands: ReadonlyArray<{ name: string; description: string }>;
  agents: ReadonlyArray<{ id: string; description: string }>;
  account: { provider: string } & Record<string, unknown>;
  readiness?: import("./api.ts").HarnessReadiness;
}

export interface SessionInfo {
  sessionKey: string;
  runKey?: string;
  workItemId?: string | null;
  runKind?: "primary" | "child";
  parentRunKey?: string | null;
  taskId?: string | null;
  sessionId: string | null;
  status: string;
  cwd: string;
  /** Stable workspace UUID supplied by the server when known. */
  projectId?: string | null;
  totalCost?: number;
  turns?: number;
  usageTotals?: SessionUsageTotals;
  model?: string | null;
  permissionMode?: string | null;
  taskName?: string | null;
  role?: "leader" | "minion" | "default";
  activeMinions?: ActiveMinion[];
  taskPlan?: SyncTaskRecord[];
  renderState?: RenderState | null;
  /** Registered harness driving this session (e.g. "claude", "echo"). */
  harness?: string;
  /**
   * Static capability flags for `harness`. `null` when the harness name is
   * not currently registered (e.g. a hydrated session whose harness module
   * was removed) — clients should fall back to safe defaults.
   */
  harnessCapabilities?: HarnessCapabilities | null;
  /** Most recent assistant response/activity timestamp from the server snapshot. */
  lastActivityAt?: number | null;
  reviewLifecycle?: SessionReviewLifecycle;
}

export type SessionReviewState =
  | "none"
  | "decision_needed"
  | "completion_to_review"
  | "error_to_review"
  | "interrupted_to_review";

export interface SessionReviewLifecycle {
  reviewState: SessionReviewState;
  reviewReason: string | null;
  finalReport: string | null;
  finalDashboardRevision: number | null;
  dashboardRevision: number;
  terminalReason: "completed" | "error" | "stop" | "abort" | null;
  terminalAt: number | null;
  acknowledgedAt: number | null;
  dismissedAt: number | null;
  lifecycleRevision: number;
}

export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
}

export interface ActiveMinion {
  taskId: string;
  title: string;
  status: string;
  sessionKey: string | null;
}

/**
 * Subscribers receive the full envelope. Its `type` / `topic` / payload
 * fields are flattened at the top level, so `(msg) => switch (msg.type)`
 * patterns continue to work unchanged — the handler type is structurally
 * compatible with `ServerMessage`.
 */
type Listener = (msg: ServerMessage) => void;
type UnknownListener = (msg: unknown) => void;

export type ReconnectState = "connected" | "reconnecting" | "failed";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const JITTER_MS = 500;
/**
 * Cap on the offline outbound queue. Messages sent while the socket is down
 * are buffered and flushed on the next open; this bounds memory if we stay
 * disconnected for a long time. When the cap is exceeded the oldest queued
 * messages are dropped (with a warning) so the newest commands survive.
 */
const MAX_PENDING_SENDS = 100;

/** Compute exponential backoff delay with jitter: 2s → 4s → 8s → 16s … capped at 30s, ±500ms jitter */
function getBackoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = (Math.random() * 2 - 1) * JITTER_MS; // random in [-500, +500]
  return Math.max(0, exponential + jitter);
}

/**
 * Subscribe to server → client envelopes.
 *
 * Two signatures:
 *   - `subscribe(fn)` — firehose. Receives every envelope. Equivalent to
 *     `subscribe("*", fn)`; retained for existing firehose subscribers.
 *   - `subscribe(topic, fn)` — topic-filtered. Receives only envelopes
 *     whose `topic` field matches the filter. Use `"*"` for firehose,
 *     `"session:<key>"` / `"project:<id>"` / `"global"` for scoped.
 */
export interface SocketSubscribe {
  (fn: Listener): () => void;
  (topic: string, fn: Listener): () => void;
  (fn: UnknownListener): () => void;
  (topic: string, fn: UnknownListener): () => void;
  readonly supportsTopics?: true;
}

export interface SyncTaskRecord {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  executor: "leader" | "minion";
  minionSessionKey: string | null;
  status: string;
  createdAt: number;
  completedAt: number | null;
  result: string | null;
}

export type SocketSubscribeLike =
  | SocketSubscribe
  | ((fn: (msg: unknown) => void) => () => void)
  | undefined;

export function subscribeSocketTopic(
  socketSubscribe: SocketSubscribeLike,
  topic: string,
  fn: UnknownListener,
): (() => void) | undefined {
  if (!socketSubscribe) return undefined;
  if ((socketSubscribe as SocketSubscribe).supportsTopics === true) {
    return (socketSubscribe as SocketSubscribe)(topic, fn);
  }
  return (socketSubscribe as (fn: UnknownListener) => () => void)(fn);
}

export function subscribeSocketTopics(
  socketSubscribe: SocketSubscribeLike,
  topics: ReadonlyArray<string>,
  fn: UnknownListener,
): (() => void) | undefined {
  if (!socketSubscribe) return undefined;
  const uniqueTopics = Array.from(new Set(topics.filter(Boolean)));
  if (uniqueTopics.length === 0) return undefined;
  if ((socketSubscribe as SocketSubscribe).supportsTopics !== true) {
    return (socketSubscribe as (listener: UnknownListener) => () => void)(fn);
  }
  const unsubscribers = uniqueTopics.map((topic) =>
    (socketSubscribe as SocketSubscribe)(topic, fn),
  );
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

interface SocketHandle {
  connected: boolean;
  reconnectState: ReconnectState;
  reconnectAttempt: number;
  manualReconnect: () => void;
  send: (data: unknown) => void;
  subscribe: SocketSubscribe;
}

interface TopicListener {
  topic: string;
  fn: UnknownListener;
}

export function useSocket(url: string): SocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<TopicListener>>(new Set());
  // Outbound messages enqueued while the socket was not OPEN (initial connect,
  // reconnect backoff, auth-token refresh). Flushed in order on the next open
  // so commands like `create_session` are never silently lost.
  const pendingSendsRef = useRef<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnectState, setReconnectState] = useState<ReconnectState>("reconnecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attemptRef = useRef(0);
  // True while a connect() is between "started" and "socket resolved". The
  // socket is created inside an async getAuthToken() .then(), so without this
  // guard a rapid re-invoke (React StrictMode's mount→unmount→mount) starts a
  // second connect before the first resolves; the teardown runs while
  // wsRef.current is still null and closes nothing, leaving BOTH sockets open
  // and sharing listenersRef → every event is delivered twice.
  const connectingRef = useRef(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (connectingRef.current) return;
    connectingRef.current = true;

    // Fetch the auth token, then connect with it as a query param
    void getAuthToken().then((token) => {
      // Re-check after async gap
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        connectingRef.current = false;
        return;
      }

      const separator = url.includes("?") ? "&" : "?";
      const authedUrl = `${url}${separator}token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(authedUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        connectingRef.current = false;
        setConnected(true);
        setReconnectState("connected");
        attemptRef.current = 0;
        setReconnectAttempt(0);

        // Flush anything queued while we were disconnected, in order. New
        // sends that arrive during the loop go straight out on the now-OPEN
        // socket, so there is no interleaving or double-send.
        if (pendingSendsRef.current.length > 0) {
          const queued = pendingSendsRef.current;
          pendingSendsRef.current = [];
          for (const serialized of queued) {
            ws.send(serialized);
          }
        }
      };

      ws.onclose = () => {
        connectingRef.current = false;
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

      ws.onerror = () => {
        connectingRef.current = false;
        ws.close();
      };
      ws.onmessage = (ev) => {
        try {
          const parsed: unknown = JSON.parse(String(ev.data));
          const result = wsEnvelopeSchema.safeParse(parsed);
          if (!result.success) {
            log.warn("envelope_rejected", {
              envelopeType: (parsed as Record<string, unknown>)?.["type"],
            });
            return;
          }
          const envelope: WsEnvelope = result.data;
          if (envelope.type === "sdk_event") {
            if (!normalizedEventEnvelopeSchema.safeParse(envelope).success) {
              log.warn("invalid_normalized_event", { topic: envelope.topic });
              return;
            }
          }
          // Envelope's top-level `type` + payload fields make it
          // structurally compatible with ServerMessage.
          const asMessage = envelope as unknown as ServerMessage;
          for (const listener of listenersRef.current) {
            if (topicMatches(listener.topic, envelope.topic)) {
              listener.fn(asMessage);
            }
          }
        } catch {
          // ignore malformed messages
        }
      };
    }).catch(() => {
      // Token fetch failed before a socket was created — release the guard so
      // a later connect() (reconnect, manualReconnect) can retry.
      connectingRef.current = false;
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
    const serialized = JSON.stringify(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(serialized);
      return;
    }

    // Socket not open yet (first connect, reconnect backoff, or token
    // refresh). Queue the message and flush it on the next open instead of
    // dropping it — otherwise a tap like "Launch leader" that fires
    // `create_session` during a disconnected window is silently lost.
    const queue = pendingSendsRef.current;
    queue.push(serialized);
    if (queue.length > MAX_PENDING_SENDS) {
      const overflow = queue.length - MAX_PENDING_SENDS;
      queue.splice(0, overflow);
      log.warn("outbound_queue_trimmed", {
        maxQueuedMessages: MAX_PENDING_SENDS,
        droppedCount: overflow,
      });
    }
  }, []);

  const subscribe = useMemo(
    () =>
      Object.assign(
        ((...args: [Listener] | [string, Listener]) => {
          const [topic, fn] = args.length === 1 ? ["*", args[0]] : args;
          const entry: TopicListener = { topic, fn: fn as UnknownListener };
          listenersRef.current.add(entry);
          return () => {
            listenersRef.current.delete(entry);
          };
        }) as SocketSubscribe,
        { supportsTopics: true as const },
      ),
    [],
  );

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
    // We just tore down any in-flight attempt (onclose was nulled above, so its
    // reset won't fire) — release the guard so the fresh connect can proceed.
    connectingRef.current = false;
    connect();
  }, [connect]);

  return { connected, reconnectState, reconnectAttempt, manualReconnect, send, subscribe };
}
