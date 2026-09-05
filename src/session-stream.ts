/**
 * Pure reducer for the shared session-stream state.
 * Key behaviours preserved:
 *   • `sync_response` → rebuild messages / cost / turns / status / error,
 *     or reset to "disconnected" when the server says the session is gone.
 *   • `sdk_event` → either accumulate streaming deltas, clear them on
 *     stream end, or convert through `normalizedToDisplayMessages`,
 *     deduplicate by `id`, collapse the duplicated assistant-then-result
 *     bubble, and capture cost/turns from usage/done events.
 *   • `session_status` → status update.
 *   • `session_error` → status:"error" + capture error text.
 *
 * **Reference equality contract:** when a message is irrelevant (wrong
 * `sessionKey`, unhandled type, or no observable change) the reducer
 * returns the *same* `state` reference so React's `===` short-circuits
 * the render.
 */

import {
  normalizedToDisplayMessages,
  type DisplayMessage,
} from "./sdk-messages.ts";
import {
  extractParentId,
  extractStreamDelta,
  isStreamEnd,
  isStreamingEvent,
} from "./streaming.ts";
import type { ServerMessage } from "./use-socket.ts";
import type { ContextDeliveryLedger } from "./context-delivery.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";

/** Statuses tracked by the shared session stream. */
export type SessionStreamStatus =
  | "disconnected"
  | "creating"
  | "running"
  | "idle"
  | "stopped"
  | "completed"
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
  /**
   * Anthropic content block index that {@link streamingText} belongs to,
   * or `null` when no block is currently streaming. The reducer flushes
   * the buffer whenever a delta arrives for a different index — without
   * this, text from `[text, tool_use, text]` would mash blocks 0 and 2
   * into a single preview bubble while the static render correctly
   * splits them.
   */
  streamingBlockIndex: number | null;
  totalCost: number;
  turns: number;
  error: string | null;
  fullError?: string | null;
  contextDelivery?: ContextDeliveryLedger | undefined;
}

/**
 * The reducer.
 *
 * @param state   current shared state
 * @param msg     inbound WebSocket message
 * @param prefix  passed to `normalizedToDisplayMessages` for stable, scoped IDs
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
    case "session_compacted":
      return reduceSessionCompacted(state, msg, prefix);
    default:
      return state;
  }
}

function reduceSessionCompacted(
  state: SessionStreamState,
  msg: Extract<ServerMessage, { type: "session_compacted" }>,
  prefix: string,
): SessionStreamState {
  if (msg.sessionKey !== state.sessionKey) return state;
  const marker = checkpointDisplayMessage(prefix, msg.checkpointId ?? String(msg.timestamp), msg.trigger, msg.timestamp);
  if (state.messages.some((message) => message.id === marker.id)) return state;
  return {
    ...state,
    messages: [...state.messages, marker],
    contextDelivery: {},
  };
}

function checkpointDisplayMessage(prefix: string, id: string, trigger: "proactive" | "context_recovery" | undefined, timestamp: number): DisplayMessage {
  const reason = trigger === "context_recovery" ? "after context-window recovery" : "at a context checkpoint";
  return { id: `${prefix}-checkpoint-${id}`, role: "system", content: `Continued in a fresh thread ${reason}.`, timestamp };
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
      streamingBlockIndex: null,
      error: null,
      fullError: null,
    };
  }

  const events = msg.events ?? [];
  const rebuilt: DisplayMessage[] = [];
  const seen = new Set<string>();
  let cost = msg.totalCost ?? state.totalCost;
  let turns = msg.turns ?? state.turns;
  let error = msg.lastError ?? null;
  let fullError = msg.lastErrorFull ?? error;
  let status: SessionStreamStatus =
    (msg.status as SessionStreamStatus | undefined) ?? state.status;

  for (const evt of events) {
    if (evt.type === "sdk_event" && evt.event) {
      const event = evt.event;
      const produced = normalizedToDisplayMessages(event, prefix);
      const filtered = collapseAssistantResultDup(rebuilt, produced, event);
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
      if (event.kind === "usage" && event.costUSD != null) {
        cost = event.costUSD;
      }
      if (event.kind === "done" && event.turns != null) {
        turns = event.turns;
      }
    } else if (evt.type === "session_status" && evt.status) {
      status = evt.status as SessionStreamStatus;
    } else if (evt.type === "session_error" && evt.error) {
      status = "error";
      error = evt.error;
      fullError = evt.fullError ?? evt.error;
    } else if (evt.type === "session_compacted") {
      const marker = checkpointDisplayMessage(prefix, evt.checkpointId ?? String(evt.timestamp), evt.trigger, evt.timestamp);
      if (!seen.has(marker.id)) { seen.add(marker.id); rebuilt.push(marker); }
    }
  }

  return {
    ...state,
    status,
    messages: rebuilt.length > 0 ? rebuilt : state.messages,
    contextDelivery: rebuilt.some(m => m.id.startsWith(`${prefix}-checkpoint-`)
      && !state.messages.some(old => old.id === m.id)) ? {} : state.contextDelivery,
    streamingText: "",
    streamingBlockIndex: null,
    totalCost: cost,
    turns,
    error,
    fullError,
  };
}

// ── sdk_event ────────────────────────────────────────────

function reduceSdkEvent(
  state: SessionStreamState,
  msg: Extract<ServerMessage, { type: "sdk_event" }>,
  prefix: string,
): SessionStreamState {
  if (!state.sessionKey || msg.sessionKey !== state.sessionKey) return state;
  const event: NormalizedEvent = msg.event;

  // ── Streaming deltas ──
  if (isStreamingEvent(event)) {
    // Drop stream events that belong to a sub-agent (Agent/Task tool).
    // Their deltas would otherwise interleave with the parent session's
    // streaming preview because they share the same sessionKey.
    if (extractParentId(event) !== null) {
      return state;
    }

    const delta = extractStreamDelta(event);
    if (delta !== null) {
      // Block boundary: a delta arrived for a different content block.
      // Reset the buffer to this block's text rather than concatenating.
      if (state.streamingBlockIndex !== delta.index) {
        return {
          ...state,
          streamingText: delta.text,
          streamingBlockIndex: delta.index,
        };
      }
      return {
        ...state,
        streamingText: (state.streamingText ?? "") + delta.text,
      };
    }
    if (isStreamEnd(event) && (state.streamingText || state.streamingBlockIndex !== null)) {
      return { ...state, streamingText: "", streamingBlockIndex: null };
    }
    return state;
  }

  // ── Usage event: replace totalCost ──
  if (event.kind === "usage") {
    if (event.costUSD != null) {
      return { ...state, totalCost: event.costUSD };
    }
    return state;
  }

  // ── Done event: capture turns, produce result/error message ──
  if (event.kind === "done") {
    const produced = normalizedToDisplayMessages(event, prefix);
    const next: SessionStreamState = {
      ...state,
      streamingText: "",
      streamingBlockIndex: null,
    };
    if (event.turns != null) next.turns = event.turns;

    if (produced.length > 0) {
      const collapse = collapseAssistantResultDup(state.messages, produced, event);
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
        }
      }
      next.messages = nextMessages;
    }
    return next;
  }

  // ── Complete messages (text, thinking, tool_call, tool_progress) ──
  const produced = normalizedToDisplayMessages(event, prefix);
  const collapse = collapseAssistantResultDup(state.messages, produced, event);

  // No new messages and no field changes → bail with same reference,
  // unless we still need to clear stale streamingText on text/thinking.
  if (collapse.appended.length === 0 && collapse.dropAssistantIdx < 0) {
    if ((event.kind === "text" && event.role === "assistant") || event.kind === "thinking") {
      if (state.streamingText || state.streamingBlockIndex !== null) {
        return { ...state, streamingText: "", streamingBlockIndex: null };
      }
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
      if ((event.kind === "text" && event.role === "assistant") || event.kind === "thinking") {
        if (state.streamingText || state.streamingBlockIndex !== null) {
          return { ...state, streamingText: "", streamingBlockIndex: null };
        }
      }
      return state;
    }
  }

  const next: SessionStreamState = { ...state, messages: nextMessages };
  // Clear streaming buffer when a complete assistant text or thinking block arrives.
  if ((event.kind === "text" && event.role === "assistant") || event.kind === "thinking") {
    next.streamingText = "";
    next.streamingBlockIndex = null;
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
  return {
    ...state,
    status: "error",
    error: msg.error,
    fullError: msg.fullError ?? msg.error,
  };
}

// ── Helpers ──────────────────────────────────────────────

/**
 * The SDK sends both the final assistant text and the `done` envelope
 * carrying the same content. Today's UI only wants the green result bubble.
 *
 * If the incoming event is a `done` with a result and the most recent
 * assistant message in `existing` has matching content (after stripping
 * `<!--task-name:...-->` markers), report which assistant index to drop.
 */
function collapseAssistantResultDup(
  existing: ReadonlyArray<DisplayMessage>,
  produced: ReadonlyArray<DisplayMessage>,
  event: NormalizedEvent,
): { appended: ReadonlyArray<DisplayMessage>; dropAssistantIdx: number } {
  if (event.kind !== "done") {
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
      // Most recent assistant didn't match — don't keep walking.
      return { appended: produced, dropAssistantIdx: -1 };
    }
  }
  return { appended: produced, dropAssistantIdx: -1 };
}

function stripTaskNameMarker(s: string): string {
  return s.replace(/<!--task-name:.+?-->\s*/g, "");
}

/**
 * Re-insert optimistic user turns that a reducer output dropped.
 *
 * Most user messages exist first as client-side optimistic appends (see
 * LeaderNode.handleSend / MinionNode.startTask). Activity-owned canonical
 * prompts are server-persisted instead because no canvas node owns their
 * local state. Two paths can still lose optimistic messages:
 *
 *   1. **sync_response rebuild** — {@link reduceSyncResponse} reconstructs the
 *      feed purely from buffered sdk events. Older/optimistic user turns are
 *      absent there, so replacing `messages` wholesale would drop them on the
 *      next reconnect or refocus sync.
 *   2. **stale-snapshot race** — an inbound event reduced against a feed
 *      snapshot taken *before* the latest optimistic append drops that append
 *      when the caller overwrites `messages` with the reducer output.
 *
 * This helper takes the caller's authoritative `prev` feed (which holds the
 * optimistic user turns) and the reducer's `next` feed, and re-inserts any
 * `user` message missing from `next` at the position it held in `prev` —
 * immediately after its nearest surviving predecessor. When nothing is
 * missing it returns `next` unchanged so reference equality is preserved.
 */
export function preserveOptimisticUserMessages(
  prev: ReadonlyArray<DisplayMessage>,
  next: ReadonlyArray<DisplayMessage>,
): DisplayMessage[] {
  const nextIds = new Set(next.map((m) => m.id));
  const missing: DisplayMessage[] = [];
  for (const m of prev) {
    if (m.role === "user" && !nextIds.has(m.id)) missing.push(m);
  }
  if (missing.length === 0) return next as DisplayMessage[];

  const result = [...next];
  for (const u of missing) {
    const idxInPrev = prev.indexOf(u);
    // Nearest preceding message in `prev` that survives in `result` becomes
    // the anchor; the missing turn is spliced in right after it. Earlier
    // re-inserted turns are already in `result`, so a run of consecutive
    // missing user turns keeps its relative order.
    let anchorIdx = -1;
    for (let i = idxInPrev - 1; i >= 0; i--) {
      const p = prev[i];
      if (!p) continue;
      const at = result.findIndex((r) => r.id === p.id);
      if (at >= 0) {
        anchorIdx = at;
        break;
      }
    }
    if (anchorIdx < 0) {
      result.unshift(u);
    } else {
      result.splice(anchorIdx + 1, 0, u);
    }
  }
  return result;
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
    streamingBlockIndex: null,
    totalCost: 0,
    turns: 0,
    error: null,
    fullError: null,
  };
}
