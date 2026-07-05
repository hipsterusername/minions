import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { getAuthToken, clearAuthToken } from "./api.ts";
import {
  wsEnvelopeSchema,
  topicMatches,
  type WsEnvelope,
} from "../shared/ws-envelope.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { RenderState } from "../shared/render-dsl.ts";

export type ServerMessage =
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "harness_list"; harnesses: HarnessListEntry[] }
  | { type: "session_created"; sessionKey: string }
  | { type: "session_status"; sessionKey: string; status: string; sessionId?: string }
  | { type: "session_error"; sessionKey: string; error: string; fullError?: string }
  | { type: "kanban_card_created"; sessionKey: string; card: { title: string; description: string; context: string; priority: "low" | "medium" | "high" | "critical"; subtasks: string[] }; timestamp: number }
  | { type: "sdk_event"; sessionKey: string; event: NormalizedEvent; timestamp?: number }
  | { type: "sync_response"; sessionKey: string; found: boolean; status?: string; sessionId?: string | null; cwd?: string; totalCost?: number; turns?: number; usageTotals?: SessionUsageTotals; lastError?: string | null; lastErrorFull?: string | null; events?: SyncEvent[]; model?: string | null; permissionMode?: string | null; initData?: Record<string, unknown>; taskName?: string | null; role?: "leader" | "minion" | "default" | "card-composer"; activeMinions?: ActiveMinion[]; taskPlan?: SyncTaskRecord[]; renderState?: RenderState | null; worktree?: { path: string; branch: string } | null; approval?: { requested?: boolean; summary?: string; diff?: unknown; graceUntil?: number } | null; harness?: string; harnessCapabilities?: HarnessCapabilities | null }
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
  event?: NormalizedEvent;
  /** @deprecated legacy test compat only — new writes use `event` */
  message?: unknown;
  status?: string;
  error?: string;
  fullError?: string;
  timestamp: number;
}

/**
 * Capability flags declared by an `AgentHarness` and surfaced to the client
 * via `sync_response` and `session_list`. Mirrors `server/harness/types.ts`
 * `HarnessCapabilities` — keep the two in sync.
 */
export interface HarnessCapabilities {
  thinking: boolean;
  promptCaching: boolean;
  mcp: boolean;
  permissionPrompts: boolean;
  resume: boolean;
  partialMessages: boolean;
  builtInFilesystem: boolean;
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
}

export interface SessionInfo {
  sessionKey: string;
  sessionId: string | null;
  status: string;
  cwd: string;
  totalCost?: number;
  turns?: number;
  usageTotals?: SessionUsageTotals;
  model?: string | null;
  permissionMode?: string | null;
  taskName?: string | null;
  role?: "leader" | "minion" | "default" | "card-composer";
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
 *     `subscribe("*", fn)`; retained so existing call sites keep working
 *     during the Phase 2 migration.
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
          const result = wsEnvelopeSchema.safeParse(parsed);
          if (!result.success) {
            console.warn(
              "[ws] Rejected message failing envelope schema:",
              (parsed as Record<string, unknown>)?.["type"],
            );
            return;
          }
          const envelope: WsEnvelope = result.data;
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
      console.warn(
        `[ws] outbound queue exceeded ${MAX_PENDING_SENDS}; dropped ${overflow} oldest message(s)`,
      );
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
    connect();
  }, [connect]);

  return { connected, reconnectState, reconnectAttempt, manualReconnect, send, subscribe };
}
