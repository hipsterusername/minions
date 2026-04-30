/**
 * Unit tests for streaming utility functions.
 *
 * Covers extractStreamDelta, isStreamEnd, isCompleteAssistant,
 * isStreamingEvent, and extractParentToolUseId from streaming.ts.
 * Message shapes are constructed as plain literals and cast to
 * SdkMessage — the union is wide enough to accept them for well-typed
 * variants; unknown top-level types use `as unknown as SdkMessage`.
 */

import { describe, it, expect } from "vitest";
import type { SdkMessage } from "./use-socket.ts";
import {
  extractParentToolUseId,
  extractStreamDelta,
  isStreamEnd,
  isCompleteAssistant,
  isStreamingEvent,
} from "./streaming.ts";

// ── extractStreamDelta ────────────────────────────────────────────────────────

describe("extractStreamDelta", () => {
  it("returns text + index for stream_event with content_block_delta (text_delta)", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "hello" },
      },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toEqual({ text: "hello", index: 2 });
  });

  it("falls back to text without an explicit delta.type for old payloads", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { text: "hello" } },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toEqual({ text: "hello", index: 0 });
  });

  it("returns null for input_json_delta (tool input streaming)", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"a":1}' },
      },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toBeNull();
  });

  it("returns null for thinking_delta (not surfaced in the streaming preview)", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "musing..." },
      },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toBeNull();
  });

  it("returns initial text + index for content_block_start carrying text", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 3,
        content_block: { type: "text", text: "initial" },
      },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toEqual({ text: "initial", index: 3 });
  });

  it("returns empty text + index for content_block_start where text is missing", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toEqual({ text: "", index: 0 });
  });

  it("defaults index to 0 when omitted", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toEqual({ text: "x", index: 0 });
  });

  it("returns null for stream_event with message_stop", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_stop" },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toBeNull();
  });

});

// ── isStreamEnd ───────────────────────────────────────────────────────────────

describe("isStreamEnd", () => {
  it("returns true for stream_event with message_stop", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_stop" },
    } as unknown as SdkMessage;
    expect(isStreamEnd(msg)).toBe(true);
  });
});

// ── Type-guard negative cases (collapsed) ────────────────────────────────────
// Collapsed: 5+ near-identical "wrong-input-shape returns null/false"
// cases across extractStreamDelta / isStreamEnd / isStreamingEvent into a
// single parameterised case. Each row covers the same negative branch in
// a different guard. See docs/testing-strategy.md §5.

describe("type-guard negative branches", () => {
  const systemMsg = {
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "u1",
    session_id: "s1",
  } as unknown as SdkMessage;
  const assistantComplete = {
    type: "assistant",
    message: {
      id: "m1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      model: "claude-3",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "u1",
    session_id: "s1",
  } as unknown as SdkMessage;
  const messageDelta = {
    type: "stream_event",
    event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
  } as unknown as SdkMessage;
  const contentBlockDelta = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  } as unknown as SdkMessage;

  it.each([
    ["extractStreamDelta on non-stream_event", () => extractStreamDelta(systemMsg), null],
    ["isStreamEnd on message_delta (pre-stop usage update)", () => isStreamEnd(messageDelta), false],
    ["isStreamEnd on content_block_delta", () => isStreamEnd(contentBlockDelta), false],
    ["isStreamEnd on non-stream_event", () => isStreamEnd(assistantComplete), false],
    ["isStreamingEvent on system message", () => isStreamingEvent(systemMsg), false],
  ] as const)("%s", (_label, run, expected) => {
    expect(run()).toBe(expected);
  });
});

// ── isCompleteAssistant ───────────────────────────────────────────────────────

describe("isCompleteAssistant", () => {
  it("returns true for an assistant message with content", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        model: "claude-3",
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SdkMessage;
    expect(isCompleteAssistant(msg)).toBe(true);
  });

  it("returns false for an assistant message without content", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-3",
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as unknown as SdkMessage;
    expect(isCompleteAssistant(msg)).toBe(false);
  });

  it("returns false for non-assistant messages", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    } as unknown as SdkMessage;
    expect(isCompleteAssistant(msg)).toBe(false);
  });
});

// ── isStreamingEvent ──────────────────────────────────────────────────────────

describe("isStreamingEvent", () => {
  it("returns true for a stream_event carrying a text delta", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    } as unknown as SdkMessage;
    expect(isStreamingEvent(msg)).toBe(true);
  });

  it("returns true for a stream-end event (message_stop)", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_stop" },
    } as unknown as SdkMessage;
    expect(isStreamingEvent(msg)).toBe(true);
  });

  // Removed: "returns false for system messages" + "returns false for
  // complete assistant messages" — folded into the parameterised
  // type-guard negative-branch suite above. See
  // docs/testing-strategy.md §5.
});

// ── extractParentToolUseId ────────────────────────────────────────────────────

describe("extractParentToolUseId", () => {
  it("returns the id when set", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: "tool-abc",
      uuid: "u",
      session_id: "s",
    } as unknown as SdkMessage;
    expect(extractParentToolUseId(msg)).toBe("tool-abc");
  });

  it("returns null when explicitly null", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: null,
      uuid: "u",
      session_id: "s",
    } as unknown as SdkMessage;
    expect(extractParentToolUseId(msg)).toBeNull();
  });

  it("returns null when missing", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
    } as unknown as SdkMessage;
    expect(extractParentToolUseId(msg)).toBeNull();
  });

  it("returns null for empty-string ids", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: "",
    } as unknown as SdkMessage;
    expect(extractParentToolUseId(msg)).toBeNull();
  });
});
