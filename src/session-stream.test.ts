/**
 * Unit tests for `sessionStreamReducer`.
 *
 * Each test pins one transition in isolation. The reducer is pure, so
 * every test builds a hand-crafted ServerMessage, runs it through the
 * reducer, and asserts both the resulting state *and* the
 * reference-equality contract (same input → same reference when nothing
 * relevant changed).
 *
 * Snapshot baselines that drive the reducer through full fixtures live
 * in `tests/harness/session-stream-snapshot.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  emptySessionStreamState,
  sessionStreamReducer,
  type SessionStreamState,
} from "./session-stream.ts";
import type { ServerMessage, SdkMessage } from "./use-socket.ts";

// ── Builders (kept tiny — only what these tests need) ──

function freshState(
  overrides: Partial<SessionStreamState> = {},
): SessionStreamState {
  return { ...emptySessionStreamState("k1"), status: "running", ...overrides };
}

function sdkEvent(sessionKey: string, message: SdkMessage): ServerMessage {
  return { type: "sdk_event", sessionKey, message };
}

function assistantText(text: string, uuid = "u-asst"): SdkMessage {
  return {
    type: "assistant",
    message: {
      id: "msg",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-opus-4-5",
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function resultMsg(text: string, cost = 0.01, turns = 1, uuid = "u-res"): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: turns,
    stop_reason: "end_turn",
    total_cost_usd: cost,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function streamDelta(
  text: string,
  uuid = "u-stm",
  index = 0,
  parentToolUseId: string | null = null,
): SdkMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    parent_tool_use_id: parentToolUseId,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function streamBlockStart(
  index: number,
  blockType: "text" | "tool_use" | "thinking" = "text",
  initialText = "",
  uuid = "u-bls",
): SdkMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: blockType === "text" ? { type: "text", text: initialText } : { type: blockType },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

function streamEnd(uuid = "u-end"): SdkMessage {
  return {
    type: "stream_event",
    event: { type: "message_stop" },
    parent_tool_use_id: null,
    uuid,
    session_id: "s1",
  } as SdkMessage;
}

// ── Reference-equality contract ────────────────────────

describe("sessionStreamReducer: reference equality", () => {
  it("returns the same state for an unrelated message type", () => {
    const state = freshState();
    const out = sessionStreamReducer(
      state,
      { type: "session_list", sessions: [] },
      "test",
    );
    expect(out).toBe(state);
  });

  it("returns the same state for an sdk_event with mismatched sessionKey", () => {
    const state = freshState({ sessionKey: "k1" });
    const out = sessionStreamReducer(
      state,
      sdkEvent("other", assistantText("hi")),
      "test",
    );
    expect(out).toBe(state);
  });

  it("returns the same state when sessionKey is null", () => {
    const state = freshState({ sessionKey: null });
    const out = sessionStreamReducer(
      state,
      sdkEvent("k1", assistantText("hi")),
      "test",
    );
    expect(out).toBe(state);
  });

  it("returns the same state for a session_status with the same status value", () => {
    const state = freshState({ status: "running" });
    const out = sessionStreamReducer(
      state,
      { type: "session_status", sessionKey: "k1", status: "running" },
      "test",
    );
    expect(out).toBe(state);
  });
});

// ── sdk_event: streaming deltas ────────────────────────

describe("sessionStreamReducer: streaming deltas", () => {
  it("appends delta text to streamingText for the same block index", () => {
    const s0 = freshState({ streamingText: "Hel", streamingBlockIndex: 0 });
    const s1 = sessionStreamReducer(s0, sdkEvent("k1", streamDelta("lo")), "t");
    expect(s1.streamingText).toBe("Hello");
    expect(s1.streamingBlockIndex).toBe(0);
    expect(s1.messages).toBe(s0.messages);
  });

  it("clears streamingText on stream end (message_stop)", () => {
    const s0 = freshState({ streamingText: "Hello", streamingBlockIndex: 0 });
    const s1 = sessionStreamReducer(s0, sdkEvent("k1", streamEnd()), "t");
    expect(s1.streamingText).toBe("");
    expect(s1.streamingBlockIndex).toBeNull();
  });

  it("returns same reference on stream end when buffer is already empty", () => {
    const s0 = freshState({ streamingText: "", streamingBlockIndex: null });
    const s1 = sessionStreamReducer(s0, sdkEvent("k1", streamEnd()), "t");
    expect(s1).toBe(s0);
  });

  // ── Multi-block isolation (regression for the conflict bug) ──

  it("resets streamingText when a delta arrives for a different block index", () => {
    // Block 0 streams "Let me check..."
    const s0 = freshState({ streamingText: "Let me check...", streamingBlockIndex: 0 });
    // Block 2 (post-tool_use) starts streaming "Now I'll..."
    const s1 = sessionStreamReducer(
      s0,
      sdkEvent("k1", streamDelta("Now I'll", "u-2", 2)),
      "t",
    );
    expect(s1.streamingText).toBe("Now I'll");
    expect(s1.streamingBlockIndex).toBe(2);
  });

  it("appends across multiple deltas of the same block, but resets on boundary", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEvent("k1", streamDelta("Hello", "u1", 0)), "t");
    s = sessionStreamReducer(s, sdkEvent("k1", streamDelta(" world", "u2", 0)), "t");
    expect(s.streamingText).toBe("Hello world");
    expect(s.streamingBlockIndex).toBe(0);
    // New text block (index 2 — block 1 was tool_use, ignored).
    s = sessionStreamReducer(s, sdkEvent("k1", streamDelta("Next", "u3", 2)), "t");
    expect(s.streamingText).toBe("Next");
    expect(s.streamingBlockIndex).toBe(2);
  });

  it("seeds streamingText from content_block_start of a text block at a new index", () => {
    const s0 = freshState({ streamingText: "old", streamingBlockIndex: 0 });
    const s1 = sessionStreamReducer(
      s0,
      sdkEvent("k1", streamBlockStart(2, "text", "fresh")),
      "t",
    );
    expect(s1.streamingText).toBe("fresh");
    expect(s1.streamingBlockIndex).toBe(2);
  });

  // ── Sub-agent isolation (regression for the conflict bug) ──

  it("drops stream_event deltas from a sub-agent (parent_tool_use_id non-null)", () => {
    const s0 = freshState({ streamingText: "parent text", streamingBlockIndex: 0 });
    const s1 = sessionStreamReducer(
      s0,
      sdkEvent("k1", streamDelta("subagent says hi", "u-sub", 0, "tool-abc")),
      "t",
    );
    expect(s1).toBe(s0);
  });

  // ── Tightened isStreamEnd (no-op on message_delta) ──

  it("does NOT clear streamingText on message_delta (only message_stop ends the stream)", () => {
    const s0 = freshState({ streamingText: "Hello", streamingBlockIndex: 0 });
    const messageDelta: SdkMessage = {
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
      parent_tool_use_id: null,
      uuid: "u-md",
      session_id: "s1",
    } as SdkMessage;
    const s1 = sessionStreamReducer(s0, sdkEvent("k1", messageDelta), "t");
    expect(s1).toBe(s0);
  });
});

// ── sdk_event: complete messages ───────────────────────

describe("sessionStreamReducer: complete messages", () => {
  it("appends an assistant message and clears streamingText", () => {
    const s0 = freshState({ streamingText: "partial" });
    const s1 = sessionStreamReducer(s0, sdkEvent("k1", assistantText("Hi")), "t");
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0]?.role).toBe("assistant");
    expect(s1.messages[0]?.content).toBe("Hi");
    expect(s1.streamingText).toBe("");
  });

  it("dedups by id (does not double-append the same assistant)", () => {
    const s0 = freshState();
    const evt = sdkEvent("k1", assistantText("Hi", "u-same"));
    const s1 = sessionStreamReducer(s0, evt, "t");
    const s2 = sessionStreamReducer(s1, evt, "t");
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages).toBe(s1.messages); // same reference — nothing changed
  });

  it("captures cost and turns from result", () => {
    const s0 = freshState();
    const s1 = sessionStreamReducer(
      s0,
      sdkEvent("k1", resultMsg("done", 0.0288, 3)),
      "t",
    );
    expect(s1.totalCost).toBe(0.0288);
    expect(s1.turns).toBe(3);
    expect(s1.streamingText).toBe("");
  });

  it("collapses the duplicate assistant when a matching result arrives", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEvent("k1", assistantText("Done.")), "t");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("assistant");

    s = sessionStreamReducer(s, sdkEvent("k1", resultMsg("Done.")), "t");
    // Assistant collapsed; only the result bubble remains.
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("result");
  });

  it("does NOT collapse when assistant content differs from result content", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEvent("k1", assistantText("Doing the work")), "t");
    s = sessionStreamReducer(s, sdkEvent("k1", resultMsg("All done!")), "t");
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]?.role).toBe("assistant");
    expect(s.messages[1]?.role).toBe("result");
  });

  it("collapses when both assistant and result carry the same `<!--task-name-->` marker", () => {
    let s = freshState();
    s = sessionStreamReducer(
      s,
      sdkEvent("k1", assistantText("<!--task-name:Foo-->\nDone.")),
      "t",
    );
    s = sessionStreamReducer(
      s,
      sdkEvent("k1", resultMsg("<!--task-name:Foo-->Done.")),
      "t",
    );
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("result");
  });
});

// ── session_status / session_error ─────────────────────

describe("sessionStreamReducer: status/error", () => {
  it("updates status on session_status", () => {
    const s0 = freshState({ status: "running" });
    const s1 = sessionStreamReducer(
      s0,
      { type: "session_status", sessionKey: "k1", status: "idle" },
      "t",
    );
    expect(s1.status).toBe("idle");
  });

  it("ignores session_status for a different sessionKey", () => {
    const s0 = freshState();
    const s1 = sessionStreamReducer(
      s0,
      { type: "session_status", sessionKey: "other", status: "stopped" },
      "t",
    );
    expect(s1).toBe(s0);
  });

  it("sets status:error and captures error text on session_error", () => {
    const s0 = freshState();
    const s1 = sessionStreamReducer(
      s0,
      { type: "session_error", sessionKey: "k1", error: "boom" },
      "t",
    );
    expect(s1.status).toBe("error");
    expect(s1.error).toBe("boom");
  });
});

// ── sync_response ──────────────────────────────────────

describe("sessionStreamReducer: sync_response", () => {
  it("rebuilds messages from buffered events with id-dedup", () => {
    const s0 = freshState({ messages: [], status: "disconnected" });
    const s1 = sessionStreamReducer(
      s0,
      {
        type: "sync_response",
        sessionKey: "k1",
        found: true,
        status: "running",
        totalCost: 0.05,
        turns: 2,
        events: [
          {
            type: "sdk_event",
            sessionKey: "k1",
            message: assistantText("Hello", "u-1"),
            timestamp: 0,
          },
          {
            // Duplicate — must not appear twice.
            type: "sdk_event",
            sessionKey: "k1",
            message: assistantText("Hello", "u-1"),
            timestamp: 0,
          },
          {
            type: "sdk_event",
            sessionKey: "k1",
            message: resultMsg("Done", 0.1, 3, "u-2"),
            timestamp: 0,
          },
        ],
      },
      "t",
    );
    expect(s1.status).toBe("running");
    expect(s1.totalCost).toBe(0.1);
    expect(s1.turns).toBe(3);
    // assistant("Hello") + result("Done") — assistant is NOT collapsed
    // because the contents differ.
    expect(s1.messages.map((m) => m.role)).toEqual(["assistant", "result"]);
  });

  it("collapses assistant during sync rebuild when result content matches", () => {
    const s0 = freshState();
    const s1 = sessionStreamReducer(
      s0,
      {
        type: "sync_response",
        sessionKey: "k1",
        found: true,
        events: [
          {
            type: "sdk_event",
            sessionKey: "k1",
            message: assistantText("All done.", "u-a"),
            timestamp: 0,
          },
          {
            type: "sdk_event",
            sessionKey: "k1",
            message: resultMsg("All done.", 0.01, 1, "u-r"),
            timestamp: 0,
          },
        ],
      },
      "t",
    );
    expect(s1.messages.map((m) => m.role)).toEqual(["result"]);
  });

  it("resets to disconnected when sync_response.found = false", () => {
    const s0 = freshState({
      sessionKey: "k1",
      status: "running",
      streamingText: "buffer",
      error: "stale",
    });
    const s1 = sessionStreamReducer(
      s0,
      { type: "sync_response", sessionKey: "k1", found: false },
      "t",
    );
    expect(s1.status).toBe("disconnected");
    expect(s1.sessionKey).toBeNull();
    expect(s1.streamingText).toBe("");
    expect(s1.error).toBeNull();
  });

  it("ignores sync_response for a different sessionKey", () => {
    const s0 = freshState();
    const s1 = sessionStreamReducer(
      s0,
      { type: "sync_response", sessionKey: "other", found: false },
      "t",
    );
    expect(s1).toBe(s0);
  });

  it("preserves existing messages when sync_response carries no events", () => {
    const s0 = freshState();
    const seeded = sessionStreamReducer(
      s0,
      sdkEvent("k1", assistantText("Hello")),
      "t",
    );
    expect(seeded.messages).toHaveLength(1);

    const synced = sessionStreamReducer(
      seeded,
      { type: "sync_response", sessionKey: "k1", found: true, events: [] },
      "t",
    );
    expect(synced.messages).toBe(seeded.messages);
  });
});

// ── emptySessionStreamState ────────────────────────────

describe("emptySessionStreamState", () => {
  it("returns a disconnected, empty state with the given sessionKey", () => {
    const s = emptySessionStreamState("k1");
    expect(s).toEqual({
      sessionKey: "k1",
      status: "disconnected",
      messages: [],
      streamingText: "",
      streamingBlockIndex: null,
      totalCost: 0,
      turns: 0,
      error: null,
    });
  });

  it("defaults sessionKey to null", () => {
    expect(emptySessionStreamState().sessionKey).toBeNull();
  });
});
