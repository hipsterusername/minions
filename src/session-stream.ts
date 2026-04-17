/**
 * Pure reducer for the shared session-stream state.
 *
 * This is the first extraction of Phase 1 (`docs/refactor-test-plan.md`).
 * It captures the WebSocket-handling shape that LeaderNode, MinionNode,
 * and ClaudeSessionNode currently re-implement nearly identically:
 *
 *   • `sync_response` → rebuild messages / cost / turns / status / error,
 *     or reset to "disconnected" when the server says the session is gone.
 *   • `sdk_event` → either accumulate streaming deltas, clear them on
 *     stream end, or run the message through `sdkToDisplayMessages`,
 *     deduplicate by `id`, collapse the duplicated assistant-then-result
 *     bubble, and capture cost/turns from `result` events.
 *   • `session_status` → status update.
 *   • `session_error` → status:"error" + capture error text.
 *
 * Anything node-specific (LeaderNode's worktree/approval restore,
 * MinionNode's task queue + auto-advance, ClaudeSessionNode's tool
 * groups) stays in the node and runs *around* the reducer.
 *
 * The reducer is pure: same inputs → same output, no side effects, no
 * React. It is the testable core that the upcoming `useSessionStream`
 * hook (and eventually `<SessionHost>`) will wrap.
 *
 * **Reference equality contract:** when a message is irrelevant (wrong
 * `sessionKey`, unhandled type, or no observable change) the reducer
 * returns the *same* `state` reference so React's `===` short-circuits
 * the render.
 */

import {
  sdkToDisplayMessages,
  type DisplayMessage,
} from "./sdk-messages.ts";
import {
  extractStreamDelta,
  isStreamEnd,
  isStreamingEvent,
} from "./streaming.ts";
import type { ServerMessage, SdkMessage } from "./use-socket.ts";

/** Statuses tracked by the shared session stream. */
export type SessionStreamStatus =
  | "disconnected"
  | "creating"
  | "running"
  | "idle"
  | "stopped"
  | "error";

/**
 * The shared subset of node state the reducer owns.
 *
 * Each node type wraps this in its own data interface (e.g. `LeaderData`
 * adds `taskPlan`, `worktreeBranch`, etc.). The node's own reducer/effect
 * spreads `SessionStreamState` over its own state on each transition.
 */
export interface SessionStreamState {
  /** Server-assigned key used to filter inbound WS traffic. */
  sessionKey: string | null;
  status: SessionStreamStatus;
  /** Rendered chat feed (deduplicated, collapsed). */
  messages: DisplayMessage[];
  /** Live partial-text buffer; cleared on assistant/result/stream-end. */
  streamingText: string;
  totalCost: number;
  turns: number;
  error: string | null;
}

/**
 * The reducer.
 *
 * @param state   current shared state
 * @param msg     inbound WebSocket message
 * @param prefix  passed to `sdkToDisplayMessages` for stable, scoped IDs
 * @returns       next state, or the same `state` reference if nothing changed
 */
export function sessionStreamReducer(
  state: SessionStreamState,
  msg: ServerMessage,
  prefix: string,
): SessionStreamState {
  switch (msg.type) {
    case "sync_response":
      return reduceSyncResponse(state, msg, prefix);
    case "sdk_event":
      return reduceSdkEvent(state, msg, prefix);
    case "session_status":
      return reduceSessionStatus(state, msg);
    case "session_error":
      return reduceSessionError(state, msg);
    default:
      return state;
  }
}

// ── sync_response ────────────────────────────────────────

function reduceSyncResponse(
  state: SessionStreamState,
  msg: Extract<ServerMessage, { type: "sync_response" }>,
  prefix: string,
): SessionStreamState {
  if (msg.sessionKey !== state.sessionKey) return state;

  if (!msg.found) {
    // Server lost the session — clear streaming buffer and disconnect.
    return {
      ...state,
      status: "disconnected",
      sessionKey: null,
      streamingText: "",
      error: null,
    };
  }

  const events = msg.events ?? [];
  const rebuilt: DisplayMessage[] = [];
  const seen = new Set<string>();
  let cost = msg.totalCost ?? state.totalCost;
  let turns = msg.turns ?? state.turns;
  let status: SessionStreamStatus =
    (msg.status as SessionStreamStatus | undefined) ?? state.status;

  for (const evt of events) {
    if (evt.type === "sdk_event" && evt.message) {
      const sdk = evt.message;
      const produced = sdkToDisplayMessages(sdk, prefix);
      const filtered = collapseAssistantResultDup(rebuilt, produced, sdk);
      for (const m of filtered.appended) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          rebuilt.push(m);
        }
      }
      if (filtered.dropAssistantIdx >= 0) {
        // Drop the prior assistant bubble that the result is collapsing.
        const dropped = rebuilt[filtered.dropAssistantIdx];
        if (dropped) seen.delete(dropped.id);
        rebuilt.splice(filtered.dropAssistantIdx, 1);
      }
      if (sdk.type === "result") {
        cost = sdk.total_cost_usd ?? cost;
        turns = sdk.num_turns ?? turns;
      }
    } else if (evt.type === "session_status" && evt.status) {
      status = evt.status as SessionStreamStatus;
    }
  }

  return {
    ...state,
    status,
    messages: rebuilt.length > 0 ? rebuilt : state.messages,
    streamingText: "",
    totalCost: cost,
    turns,
    error: msg.lastError ?? null,
  };
}

// ── sdk_event ────────────────────────────────────────────

function reduceSdkEvent(
  state: SessionStreamState,
  msg: Extract<ServerMessage, { type: "sdk_event" }>,
  prefix: string,
): SessionStreamState {
  if (!state.sessionKey || msg.sessionKey !== state.sessionKey) return state;
  const sdk: SdkMessage = msg.message;

  // ── Streaming deltas ──
  if (isStreamingEvent(sdk)) {
    const delta = extractStreamDelta(sdk);
    if (delta !== null) {
      return {
        ...state,
        streamingText: (state.streamingText ?? "") + delta,
      };
    }
    if (isStreamEnd(sdk) && state.streamingText) {
      return { ...state, streamingText: "" };
    }
    return state;
  }

  // ── Complete messages ──
  const produced = sdkToDisplayMessages(sdk, prefix);
  const collapse = collapseAssistantResultDup(state.messages, produced, sdk);

  // No new messages and no field changes → bail with same reference,
  // unless we still need to clear stale streamingText on assistant/result.
  if (collapse.appended.length === 0 && collapse.dropAssistantIdx < 0) {
    if (sdk.type === "assistant" && state.streamingText) {
      return { ...state, streamingText: "" };
    }
    if (sdk.type === "result") {
      return {
        ...state,
        totalCost: sdk.total_cost_usd ?? state.totalCost,
        turns: sdk.num_turns ?? state.turns,
        streamingText: "",
      };
    }
    return state;
  }

  let nextMessages = state.messages;
  if (collapse.dropAssistantIdx >= 0) {
    nextMessages = [
      ...nextMessages.slice(0, collapse.dropAssistantIdx),
      ...nextMessages.slice(collapse.dropAssistantIdx + 1),
    ];
  }
  if (collapse.appended.length > 0) {
    const existing = new Set(nextMessages.map((m) => m.id));
    const dedup = collapse.appended.filter((m) => !existing.has(m.id));
    if (dedup.length > 0) {
      nextMessages = [...nextMessages, ...dedup];
    } else if (nextMessages === state.messages && collapse.dropAssistantIdx < 0) {
      // Nothing new and no drop — bail.
      if (sdk.type === "assistant" && state.streamingText) {
        return { ...state, streamingText: "" };
      }
      if (sdk.type === "result") {
        return {
          ...state,
          totalCost: sdk.total_cost_usd ?? state.totalCost,
          turns: sdk.num_turns ?? state.turns,
          streamingText: "",
        };
      }
      return state;
    }
  }

  const next: SessionStreamState = { ...state, messages: nextMessages };
  if (sdk.type === "assistant") {
    next.streamingText = "";
  } else if (sdk.type === "result") {
    next.streamingText = "";
    next.totalCost = sdk.total_cost_usd ?? state.totalCost;
    next.turns = sdk.num_turns ?? state.turns;
  }
  return next;
}

// ── session_status / session_error ──────────────────────

function reduceSessionStatus(
  state: SessionStreamState,
  msg: Extract<ServerMessage, { type: "session_status" }>,
): SessionStreamState {
  if (msg.sessionKey !== state.sessionKey) return state;
  const next = msg.status as SessionStreamStatus;
  if (next === state.status) return state;
  return { ...state, status: next };
}

function reduceSessionError(
  state: SessionStreamState,
  msg: Extract<ServerMessage, { type: "session_error" }>,
): SessionStreamState {
  if (msg.sessionKey !== state.sessionKey) return state;
  return { ...state, status: "error", error: msg.error };
}

// ── Helpers ──────────────────────────────────────────────

/**
 * The SDK sends both the final `assistant` text and the `result` envelope
 * carrying the same content. Today's UI only wants the green result bubble.
 *
 * If the incoming SDK message is a `result` and the most recent assistant
 * message in `existing` has matching content (after stripping
 * `<!--task-name:...-->` markers), report which assistant index to drop.
 *
 * Returns:
 *   - `appended`: the produced messages, unmodified
 *   - `dropAssistantIdx`: index in `existing` to drop, or -1 if no collapse
 */
function collapseAssistantResultDup(
  existing: ReadonlyArray<DisplayMessage>,
  produced: ReadonlyArray<DisplayMessage>,
  sdk: SdkMessage,
): { appended: ReadonlyArray<DisplayMessage>; dropAssistantIdx: number } {
  if (sdk.type !== "result") {
    return { appended: produced, dropAssistantIdx: -1 };
  }
  const resultMsg = produced.find((m) => m.role === "result");
  if (!resultMsg) {
    return { appended: produced, dropAssistantIdx: -1 };
  }
  const normalized = stripTaskNameMarker(resultMsg.content).trim();
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i];
    if (m && m.role === "assistant") {
      if (stripTaskNameMarker(m.content).trim() === normalized) {
        return { appended: produced, dropAssistantIdx: i };
      }
      // Most recent assistant didn't match — don't keep walking; the SDK
      // contract is that the duplicate is the *immediately preceding*
      // assistant, not any earlier one.
      return { appended: produced, dropAssistantIdx: -1 };
    }
  }
  return { appended: produced, dropAssistantIdx: -1 };
}

function stripTaskNameMarker(s: string): string {
  return s.replace(/<!--task-name:.+?-->\s*/g, "");
}

/** Convenience: a fresh empty state. */
export function emptySessionStreamState(
  sessionKey: string | null = null,
): SessionStreamState {
  return {
    sessionKey,
    status: "disconnected",
    messages: [],
    streamingText: "",
    totalCost: 0,
    turns: 0,
    error: null,
  };
}
