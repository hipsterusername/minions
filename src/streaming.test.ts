/**
 * Unit tests for streaming utility functions.
 *
 * Phase 3: all helpers take NormalizedEvent (discriminated by `kind`).
 * Tests cover extractStreamDelta, isStreamEnd, isCompleteAssistant,
 * isStreamingEvent, and extractParentId.
 */

import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import {
  extractParentId,
  extractStreamDelta,
  isStreamEnd,
  isCompleteAssistant,
  isStreamingEvent,
} from "./streaming.ts";

// ── extractStreamDelta ────────────────────────────────────────────────────────

describe("extractStreamDelta", () => {
  it("returns text + index for a text_delta event", () => {
    const event: NormalizedEvent = { kind: "text_delta", text: "hello", blockIndex: 2 };
    expect(extractStreamDelta(event)).toEqual({ text: "hello", index: 2 });
  });

  it("returns null for text_delta with a parentId (sub-agent delta)", () => {
    const event: NormalizedEvent = {
      kind: "text_delta", text: "hi", blockIndex: 0, parentId: "tool-xyz",
    };
    expect(extractStreamDelta(event)).toBeNull();
  });

  it("returns null for stream_end", () => {
    const event: NormalizedEvent = { kind: "stream_end" };
    expect(extractStreamDelta(event)).toBeNull();
  });

  it("returns null for a complete text event", () => {
    const event: NormalizedEvent = { kind: "text", text: "done", role: "assistant" };
    expect(extractStreamDelta(event)).toBeNull();
  });

  it("returns null for a thinking event", () => {
    const event: NormalizedEvent = { kind: "thinking", text: "pondering" };
    expect(extractStreamDelta(event)).toBeNull();
  });
});

// ── isStreamEnd ───────────────────────────────────────────────────────────────

describe("isStreamEnd", () => {
  it("returns true for stream_end", () => {
    const event: NormalizedEvent = { kind: "stream_end" };
    expect(isStreamEnd(event)).toBe(true);
  });
});

// ── Type-guard negative branches ──────────────────────────────────────────────
// Parameterised to avoid repeating near-identical negative cases.

describe("type-guard negative branches", () => {
  const assistantText: NormalizedEvent = { kind: "text", text: "done", role: "assistant" };
  const thinking: NormalizedEvent = { kind: "thinking", text: "musing..." };
  const textDelta: NormalizedEvent = { kind: "text_delta", text: "hi", blockIndex: 0 };
  const toolCall: NormalizedEvent = { kind: "tool_call", id: "t1", name: "Read", input: {} };

  it.each([
    ["extractStreamDelta on complete text event", () => extractStreamDelta(assistantText), null],
    ["extractStreamDelta on thinking event", () => extractStreamDelta(thinking), null],
    ["extractStreamDelta on tool_call event", () => extractStreamDelta(toolCall), null],
    ["isStreamEnd on text_delta", () => isStreamEnd(textDelta), false],
    ["isStreamEnd on complete text", () => isStreamEnd(assistantText), false],
    ["isStreamingEvent on complete text", () => isStreamingEvent(assistantText), false],
    ["isStreamingEvent on thinking", () => isStreamingEvent(thinking), false],
  ] as const)("%s", (_label, run, expected) => {
    expect(run()).toBe(expected);
  });
});

// ── isCompleteAssistant ───────────────────────────────────────────────────────

describe("isCompleteAssistant", () => {
  it("returns true for a text event with role assistant", () => {
    const event: NormalizedEvent = { kind: "text", text: "hi", role: "assistant" };
    expect(isCompleteAssistant(event)).toBe(true);
  });

  it("returns false for a text event with role user", () => {
    const event: NormalizedEvent = { kind: "text", text: "hi", role: "user" };
    expect(isCompleteAssistant(event)).toBe(false);
  });

  it("returns false for a thinking event", () => {
    const event: NormalizedEvent = { kind: "thinking", text: "pondering" };
    expect(isCompleteAssistant(event)).toBe(false);
  });

  it("returns false for a text_delta event", () => {
    const event: NormalizedEvent = { kind: "text_delta", text: "partial", blockIndex: 0 };
    expect(isCompleteAssistant(event)).toBe(false);
  });
});

// ── isStreamingEvent ──────────────────────────────────────────────────────────

describe("isStreamingEvent", () => {
  it("returns true for a text_delta", () => {
    const event: NormalizedEvent = { kind: "text_delta", text: "hi", blockIndex: 0 };
    expect(isStreamingEvent(event)).toBe(true);
  });

  it("returns true for stream_end", () => {
    const event: NormalizedEvent = { kind: "stream_end" };
    expect(isStreamingEvent(event)).toBe(true);
  });
});

// ── extractParentId ───────────────────────────────────────────────────────────

describe("extractParentId", () => {
  it("returns the parentId when set on text_delta", () => {
    const event: NormalizedEvent = {
      kind: "text_delta", text: "x", blockIndex: 0, parentId: "tool-abc",
    };
    expect(extractParentId(event)).toBe("tool-abc");
  });

  it("returns null when parentId is absent", () => {
    const event: NormalizedEvent = { kind: "text_delta", text: "x", blockIndex: 0 };
    expect(extractParentId(event)).toBeNull();
  });

  it("returns null when parentId is empty string", () => {
    const event = {
      kind: "text_delta", text: "x", blockIndex: 0, parentId: "",
    } as NormalizedEvent;
    expect(extractParentId(event)).toBeNull();
  });

  it("returns null for tool_call event with no parentId", () => {
    const event: NormalizedEvent = { kind: "tool_call", id: "t1", name: "Read", input: {} };
    expect(extractParentId(event)).toBeNull();
  });

  it("returns parentId from tool_call with parentId set", () => {
    const event: NormalizedEvent = {
      kind: "tool_call", id: "t1", name: "Read", input: {}, parentId: "parent-tool",
    };
    expect(extractParentId(event)).toBe("parent-tool");
  });
});
