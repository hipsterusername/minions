/**
 * Streaming utilities — extracts incremental text from NormalizedEvent messages.
 * **Block-index awareness.** `text_delta` events carry a `blockIndex` that
 * identifies which content block is streaming. {@link extractStreamDelta}
 * surfaces this so the reducer can flush its buffer when a delta crosses a
 * block boundary — preventing text from `[text, tool_use, text]` from
 * mashing together in the live preview.
 *
 * **Sub-agent isolation.** {@link extractParentId} returns the `parentId`
 * of an event. The reducer uses it to drop events belonging to a sub-agent
 * (Agent/Task tool) so their deltas don't pollute the parent session's
 * streaming preview.
 */

import type { NormalizedEvent } from "../shared/normalized-event.ts";

/** A streaming text delta plus the block index it belongs to. */
export interface StreamDelta {
  /** New text chunk for the active text content block. */
  text: string;
  /** Content block index — used to detect block boundaries. */
  index: number;
}

/**
 * If `event` is a streaming text delta for a `text_delta` block AND it
 * belongs to the top-level session (parentId is null/undefined), return
 * the new chunk plus its block index. Returns `null` for everything else
 * (sub-agent deltas, stream_end, non-streaming events, tool deltas).
 *
 * Callers MUST inspect the returned `index` and reset their buffer when
 * it differs from the previously-streaming index — otherwise text from
 * separate content blocks merges into a single mashed-together preview.
 */
export function extractStreamDelta(event: NormalizedEvent): StreamDelta | null {
  if (event.kind !== "text_delta") return null;
  if (event.parentId != null) return null;
  return { text: event.text, index: event.blockIndex };
}

/**
 * Check if an event signals the end of the message stream.
 */
export function isStreamEnd(event: NormalizedEvent): boolean {
  return event.kind === "stream_end";
}

/**
 * Check if an event is a streaming event we should process
 * (as opposed to a complete message we handle normally).
 */
export function isStreamingEvent(event: NormalizedEvent): boolean {
  return event.kind === "text_delta" || event.kind === "stream_end";
}

/**
 * Check if an event is a complete assistant text turn (non-streaming).
 */
export function isCompleteAssistant(event: NormalizedEvent): boolean {
  return event.kind === "text" && event.role === "assistant";
}

/**
 * Return the `parentId` of an event (for text_delta / tool_call /
 * tool_progress), or `null` if the event has no parent (top-level)
 * or doesn't carry the field.
 *
 * Used by the reducer to drop events emitted by sub-agents (the SDK's
 * built-in Agent/Task tool) so their deltas don't append to the parent
 * session's streaming preview.
 */
export function extractParentId(event: NormalizedEvent): string | null {
  const id = (event as { parentId?: string | null }).parentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
