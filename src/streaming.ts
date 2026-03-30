/**
 * Streaming utilities – extracts partial text from SDK stream_event messages.
 *
 * The Claude Agent SDK can emit `stream_event` type messages that contain
 * `content_block_delta` events with incremental text. This module provides
 * helpers to detect and accumulate those deltas.
 */

import type { SdkMessage } from "./use-socket.ts";

/**
 * Check if an SDK message is a streaming text delta.
 * Returns the delta text if it is, or null otherwise.
 */
export function extractStreamDelta(sdkMsg: SdkMessage): string | null {
  // Handle stream_event wrapper with nested event object
  if (sdkMsg.type === "stream_event" && sdkMsg.event) {
    const evt = sdkMsg.event;
    if (evt.type === "content_block_delta" && evt.delta?.text) {
      return evt.delta.text;
    }
    // content_block_start with initial text
    if (evt.type === "content_block_start" && evt.content_block?.type === "text") {
      return evt.content_block.text ?? null;
    }
  }

  // Handle direct content_block_delta (if SDK emits at top level)
  if (sdkMsg.type === "content_block_delta") {
    const delta = sdkMsg.event?.delta ?? (sdkMsg as Record<string, unknown>)["delta"] as { text?: string } | undefined;
    if (delta?.text) return delta.text;
  }

  return null;
}

/**
 * Check if an SDK message signals the end of a content stream.
 */
export function isStreamEnd(sdkMsg: SdkMessage): boolean {
  if (sdkMsg.type === "stream_event" && sdkMsg.event) {
    return (
      sdkMsg.event.type === "message_stop" ||
      sdkMsg.event.type === "message_delta"
    );
  }
  return false;
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
