/**
 * Streaming utilities — extracts partial text from SDK stream_event messages.
 *
 * The Claude Agent SDK can emit `stream_event` type messages that contain
 * `content_block_delta` events with incremental text. This module provides
 * helpers to detect and accumulate those deltas.
 *
 * **Block-index awareness.** A single assistant message may contain
 * multiple content blocks (e.g. `[text, tool_use, text]`). Each Anthropic
 * stream event carries an `index: number` identifying which block it
 * belongs to. {@link extractStreamDelta} surfaces this index so the
 * reducer can flush its buffer when the streaming text crosses a block
 * boundary — without it, deltas from blocks 0 and 2 would mash together
 * in the live preview while the final static render (which splits per
 * block via `sdkToDisplayMessages`) shows them as separate bubbles.
 *
 * **Sub-agent isolation.** {@link extractParentToolUseId} returns the
 * `parent_tool_use_id` of an SDK message. The reducer uses it to drop
 * stream events that belong to a sub-agent (`Agent`/`Task` tool) so its
 * deltas don't pollute the parent session's streaming preview.
 */

import type { SdkMessage } from "./use-socket.ts";

/**
 * Narrowed shape of a `stream_event`'s `event` payload — Anthropic's
 * `BetaRawMessageStreamEvent`. We only inspect the fields we care about.
 */
interface StreamEventPayload {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  content_block?: { type?: string; text?: string };
}

function asEventPayload(evt: Record<string, unknown>): StreamEventPayload {
  return evt as StreamEventPayload;
}

/** A streaming text delta plus the block index it belongs to. */
export interface StreamDelta {
  /** New text chunk for the active text content block. */
  text: string;
  /** Anthropic content block index — used to detect block boundaries. */
  index: number;
}

/**
 * If `sdkMsg` is a streaming text delta for a `text` content block, return
 * the new chunk plus its block index. Returns `null` for everything else
 * (tool_use input deltas, thinking deltas, citations, signatures, the
 * content_block_start of non-text blocks, message-level events, etc.).
 *
 * Callers MUST inspect the returned `index` and reset their buffer when
 * it differs from the previously-streaming index — otherwise text from
 * separate content blocks merges into a single mashed-together preview.
 */
export function extractStreamDelta(sdkMsg: SdkMessage): StreamDelta | null {
  if (sdkMsg.type !== "stream_event" || !sdkMsg.event) return null;
  const evt = asEventPayload(sdkMsg.event);
  const index = typeof evt.index === "number" ? evt.index : 0;

  if (evt.type === "content_block_delta") {
    // Only `text_delta` flows into the streaming preview. `input_json_delta`
    // (tool input), `thinking_delta`, `citations_delta`, `signature_delta`,
    // and `compaction_content_block_delta` are intentionally dropped here —
    // each has its own surface in the static render.
    if (evt.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
      return { text: evt.delta.text, index };
    }
    // Some older payloads omit `delta.type` but carry `delta.text`. Treat
    // those as text_delta for backwards compatibility.
    if (!evt.delta?.type && typeof evt.delta?.text === "string") {
      return { text: evt.delta.text, index };
    }
    return null;
  }

  if (evt.type === "content_block_start" && evt.content_block?.type === "text") {
    const initial = evt.content_block.text ?? "";
    return { text: initial, index };
  }

  return null;
}

/**
 * Check if an SDK message signals the end of the message stream.
 *
 * Only `message_stop` is a true terminator. `message_delta` is a
 * pre-stop usage/stop_reason update and is intentionally NOT treated
 * as end-of-stream — that historic behaviour caused the streaming
 * preview to flicker out one tick before the final assistant message
 * arrived.
 */
export function isStreamEnd(sdkMsg: SdkMessage): boolean {
  if (sdkMsg.type !== "stream_event" || !sdkMsg.event) return false;
  const evt = asEventPayload(sdkMsg.event);
  return evt.type === "message_stop";
}

/**
 * Check if an SDK message is a complete assistant turn (non-streaming).
 */
export function isCompleteAssistant(sdkMsg: SdkMessage): boolean {
  return sdkMsg.type === "assistant" && !!sdkMsg.message?.content;
}

/**
 * Check if an SDK message is a streaming event we should process
 * (as opposed to a complete message we handle normally).
 */
export function isStreamingEvent(sdkMsg: SdkMessage): boolean {
  return extractStreamDelta(sdkMsg) !== null || isStreamEnd(sdkMsg);
}

/**
 * Return the `parent_tool_use_id` of an SDK message, or `null` if the
 * message has no parent (top-level) or doesn't carry the field.
 *
 * Used by the reducer to drop stream events emitted by sub-agents
 * (the SDK's built-in `Agent`/`Task` tool) so their text deltas don't
 * append to the parent session's streaming preview.
 */
export function extractParentToolUseId(sdkMsg: SdkMessage): string | null {
  const id = (sdkMsg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
