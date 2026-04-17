/**
 * Unit tests for streaming utility functions.
 *
 * Covers extractStreamDelta, isStreamEnd, isCompleteAssistant, and
 * isStreamingEvent from streaming.ts. Message shapes are constructed as plain
 * literals and cast to SdkMessage — the union is wide enough to accept them
 * for well-typed variants; unknown top-level types use `as unknown as SdkMessage`.
 */

import { describe, it, expect } from "vitest";
import type { SdkMessage } from "./use-socket.ts";
import {
  extractStreamDelta,
  isStreamEnd,
  isCompleteAssistant,
  isStreamingEvent,
} from "./streaming.ts";

// ── extractStreamDelta ────────────────────────────────────────────────────────

describe("extractStreamDelta", () => {
  it("returns delta text for stream_event with content_block_delta", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "hello" } },
    } as SdkMessage;
    expect(extractStreamDelta(msg)).toBe("hello");
  });

  it("returns initial text for stream_event with content_block_start carrying text", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "text", text: "initial" },
      },
    } as SdkMessage;
    expect(extractStreamDelta(msg)).toBe("initial");
  });

  it("returns null for content_block_start where content_block has no text", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "text" },
      },
    } as SdkMessage;
    expect(extractStreamDelta(msg)).toBeNull();
  });

  it("returns null for stream_event with message_stop", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_stop" },
    } as SdkMessage;
    expect(extractStreamDelta(msg)).toBeNull();
  });

  it("returns null for non-stream_event messages", () => {
    const msg = {
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "u1",
      session_id: "s1",
    } as SdkMessage;
    expect(extractStreamDelta(msg)).toBeNull();
  });

  it("returns text from top-level delta for direct content_block_delta shape", () => {
    const msg = {
      type: "content_block_delta",
      delta: { text: "world" },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toBe("world");
  });

  it("returns text from event.delta for direct content_block_delta with event wrapper", () => {
    const msg = {
      type: "content_block_delta",
      event: { delta: { text: "via-event" } },
    } as unknown as SdkMessage;
    expect(extractStreamDelta(msg)).toBe("via-event");
  });
});

// ── isStreamEnd ───────────────────────────────────────────────────────────────

describe("isStreamEnd", () => {
  it("returns true for stream_event with message_stop", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_stop" },
    } as SdkMessage;
    expect(isStreamEnd(msg)).toBe(true);
  });

  it("returns true for stream_event with message_delta", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
    } as SdkMessage;
    expect(isStreamEnd(msg)).toBe(true);
  });

  it("returns false for stream_event with content_block_delta", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "hi" } },
    } as SdkMessage;
    expect(isStreamEnd(msg)).toBe(false);
  });

  it("returns false for non-stream_event messages", () => {
    const msg = {
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
    } as SdkMessage;
    expect(isStreamEnd(msg)).toBe(false);
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
    } as SdkMessage;
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
    } as SdkMessage;
    expect(isCompleteAssistant(msg)).toBe(false);
  });

  it("returns false for non-assistant messages", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "partial" } },
    } as SdkMessage;
    expect(isCompleteAssistant(msg)).toBe(false);
  });
});

// ── isStreamingEvent ──────────────────────────────────────────────────────────

describe("isStreamingEvent", () => {
  it("returns true for a stream_event carrying a text delta", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "hi" } },
    } as SdkMessage;
    expect(isStreamingEvent(msg)).toBe(true);
  });

  it("returns true for a stream-end event (message_stop)", () => {
    const msg = {
      type: "stream_event",
      event: { type: "message_stop" },
    } as SdkMessage;
    expect(isStreamingEvent(msg)).toBe(true);
  });

  it("returns false for system messages", () => {
    const msg: SdkMessage = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      claude_code_version: "1.0",
      cwd: "/",
      tools: [],
      model: "m",
      permissionMode: "auto",
      apiKeySource: "env",
      mcp_servers: [],
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: "u1",
    };
    expect(isStreamingEvent(msg)).toBe(false);
  });

  it("returns false for complete assistant messages", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "complete" }],
        model: "claude-3",
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    } as SdkMessage;
    expect(isStreamingEvent(msg)).toBe(false);
  });
});
