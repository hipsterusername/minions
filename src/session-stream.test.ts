/**
 * Unit tests for `sessionStreamReducer`.
 *
 * Phase 3: all builders create NormalizedEvent objects (discriminated by
 * `kind`) rather than the legacy SdkMessage union. The reducer is pure, so
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
  preserveOptimisticUserMessages,
  sessionStreamReducer,
  type SessionStreamState,
} from "./session-stream.ts";
import type { ServerMessage } from "./use-socket.ts";
import type { DisplayMessage } from "./sdk-messages.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";

// ── Builders (kept tiny — only what these tests need) ──

function freshState(
  overrides: Partial<SessionStreamState> = {},
): SessionStreamState {
  return { ...emptySessionStreamState("k1"), status: "running", ...overrides };
}

function sdkEvent(sessionKey: string, event: NormalizedEvent): ServerMessage {
  return { type: "sdk_event", sessionKey, event };
}

function assistantText(text: string): NormalizedEvent {
  return { kind: "text", text, role: "assistant" };
}

function doneEvent(
  text: string,
  turns = 1,
  reason: "completed" | "stop" | "error" | "abort" = "completed",
): NormalizedEvent {
  return { kind: "done", reason, result: text, turns };
}

function usageEvent(costUSD: number): NormalizedEvent {
  return { kind: "usage", input: 1, output: 1, costUSD };
}

function streamDelta(
  text: string,
  index = 0,
  parentId?: string,
): NormalizedEvent {
  if (parentId !== undefined) {
    return { kind: "text_delta", text, blockIndex: index, parentId };
  }
  return { kind: "text_delta", text, blockIndex: index };
}

function streamBlockStart(index: number, initialText = ""): NormalizedEvent {
  // In Phase 3, content_block_start maps to a text_delta with the initial text.
  return { kind: "text_delta", text: initialText, blockIndex: index };
}

function streamEnd(): NormalizedEvent {
  return { kind: "stream_end" };
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

  // ── Multi-block isolation (regression for the conflict bug) ──

  it("resets streamingText when a delta arrives for a different block index", () => {
    // Block 0 streams "Let me check..."
    const s0 = freshState({ streamingText: "Let me check...", streamingBlockIndex: 0 });
    // Block 2 (post-tool_use) starts streaming "Now I'll..."
    const s1 = sessionStreamReducer(
      s0,
      sdkEvent("k1", streamDelta("Now I'll", 2)),
      "t",
    );
    expect(s1.streamingText).toBe("Now I'll");
    expect(s1.streamingBlockIndex).toBe(2);
  });

  it("appends across multiple deltas of the same block, but resets on boundary", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEvent("k1", streamDelta("Hello", 0)), "t");
    s = sessionStreamReducer(s, sdkEvent("k1", streamDelta(" world", 0)), "t");
    expect(s.streamingText).toBe("Hello world");
    expect(s.streamingBlockIndex).toBe(0);
    // New text block (index 2 — block 1 was tool_use, ignored).
    s = sessionStreamReducer(s, sdkEvent("k1", streamDelta("Next", 2)), "t");
    expect(s.streamingText).toBe("Next");
    expect(s.streamingBlockIndex).toBe(2);
  });

  it("seeds streamingText from content_block_start of a text block at a new index", () => {
    const s0 = freshState({ streamingText: "old", streamingBlockIndex: 0 });
    const s1 = sessionStreamReducer(
      s0,
      sdkEvent("k1", streamBlockStart(2, "fresh")),
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
      sdkEvent("k1", streamDelta("subagent says hi", 0, "tool-abc")),
      "t",
    );
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
    // Phase 3 dedup is content-based: same text → same derived ID.
    const evt = sdkEvent("k1", assistantText("Hi"));
    const s1 = sessionStreamReducer(s0, evt, "t");
    const s2 = sessionStreamReducer(s1, evt, "t");
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages).toBe(s1.messages); // same reference — nothing changed
  });

  it("captures cost from usage event and turns from done event", () => {
    const s0 = freshState();
    // Usage event → updates totalCost only.
    const s1 = sessionStreamReducer(s0, sdkEvent("k1", usageEvent(0.0288)), "t");
    expect(s1.totalCost).toBe(0.0288);
    // Done event → updates turns (and adds result message).
    const s2 = sessionStreamReducer(
      s1,
      sdkEvent("k1", doneEvent("done", 3)),
      "t",
    );
    expect(s2.turns).toBe(3);
    expect(s2.streamingText).toBe("");
  });

  it("collapses the duplicate assistant when a matching result arrives", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEvent("k1", assistantText("Done.")), "t");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("assistant");

    s = sessionStreamReducer(s, sdkEvent("k1", doneEvent("Done.")), "t");
    // Assistant collapsed; only the result bubble remains.
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("result");
  });

  it("does NOT collapse when assistant content differs from result content", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEvent("k1", assistantText("Doing the work")), "t");
    s = sessionStreamReducer(s, sdkEvent("k1", doneEvent("All done!")), "t");
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
      sdkEvent("k1", doneEvent("<!--task-name:Foo-->Done.")),
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
      {
        type: "session_error",
        sessionKey: "k1",
        error: "boom",
        fullError: "boom\nfull stderr",
      },
      "t",
    );
    expect(s1.status).toBe("error");
    expect(s1.error).toBe("boom");
    expect(s1.fullError).toBe("boom\nfull stderr");
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
            event: { kind: "text", text: "Hello", role: "assistant" },
            timestamp: 0,
          },
          {
            // Duplicate — must not appear twice (content-based dedup).
            type: "sdk_event",
            sessionKey: "k1",
            event: { kind: "text", text: "Hello", role: "assistant" },
            timestamp: 0,
          },
          {
            type: "sdk_event",
            sessionKey: "k1",
            event: { kind: "usage", input: 1, output: 1, costUSD: 0.1 },
            timestamp: 0,
          },
          {
            type: "sdk_event",
            sessionKey: "k1",
            event: { kind: "done", reason: "completed", result: "Done", turns: 3 },
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

  it("restores fullError from buffered session_error events", () => {
    const s0 = freshState({ messages: [], status: "disconnected" });
    const s1 = sessionStreamReducer(
      s0,
      {
        type: "sync_response",
        sessionKey: "k1",
        found: true,
        status: "running",
        events: [
          {
            type: "session_error",
            sessionKey: "k1",
            error: "short",
            fullError: "short\nfull stderr",
            timestamp: 0,
          },
        ],
      },
      "t",
    );
    expect(s1.status).toBe("error");
    expect(s1.error).toBe("short");
    expect(s1.fullError).toBe("short\nfull stderr");
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
            event: { kind: "text", text: "All done.", role: "assistant" },
            timestamp: 0,
          },
          {
            type: "sdk_event",
            sessionKey: "k1",
            event: { kind: "done", reason: "completed", result: "All done.", turns: 1 },
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
      fullError: null,
    });
  });

  it("defaults sessionKey to null", () => {
    expect(emptySessionStreamState().sessionKey).toBeNull();
  });
});

describe("sessionStreamReducer: continuity marker", () => {
  it("adds one durable system marker for a committed checkpoint", () => {
    const state = freshState();
    const message: ServerMessage = {
      type: "session_compacted",
      sessionKey: "k1",
      checkpointId: "cp-1",
      trigger: "context_recovery",
      oldSessionId: "old",
      newSessionId: "new",
      timestamp: 42,
    };
    const first = sessionStreamReducer(state, message, "test");
    const second = sessionStreamReducer(first, message, "test");
    expect(first.messages.at(-1)).toMatchObject({
      id: "test-checkpoint-cp-1",
      role: "system",
      content: expect.stringContaining("context-window recovery"),
    });
    expect(second).toBe(first);
  });

  it("rebuilds checkpoint markers from the persisted event buffer", () => {
    const next = sessionStreamReducer(freshState(), {
      type: "sync_response", sessionKey: "k1", found: true,
      events: [{ type: "session_compacted", sessionKey: "k1", checkpointId: "cp-2", trigger: "proactive", timestamp: 43 }],
    }, "test");
    expect(next.messages).toContainEqual(expect.objectContaining({ id: "test-checkpoint-cp-2", role: "system" }));
  });
});

// ── preserveOptimisticUserMessages ─────────────────────

describe("preserveOptimisticUserMessages", () => {
  const m = (
    id: string,
    role: DisplayMessage["role"],
    content = id,
  ): DisplayMessage => ({ id, role, content, timestamp: 0 });

  it("returns next unchanged (same reference) when no user turns are missing", () => {
    const prev = [m("u1", "user"), m("a1", "assistant")];
    const next = [m("u1", "user"), m("a1", "assistant"), m("a2", "assistant")];
    expect(preserveOptimisticUserMessages(prev, next)).toBe(next);
  });

  it("re-grafts a user turn wiped by a sync rebuild (events carry no user turns)", () => {
    // Feed the user sees before a reconnect.
    const prev = [m("u1", "user"), m("a1", "assistant")];
    // sync_response rebuilds purely from sdk events → no user messages.
    const next = [m("a1", "assistant")];
    const merged = preserveOptimisticUserMessages(prev, next);
    expect(merged.map((x) => x.id)).toEqual(["u1", "a1"]);
  });

  it("re-inserts the latest optimistic user turn after its predecessor (stale-snapshot race)", () => {
    // prev is the authoritative feed with the just-sent user turn last.
    const prev = [
      m("u1", "user"),
      m("a1", "assistant"),
      m("u2", "user"),
    ];
    // A reduction that ran against the pre-append snapshot appended a2 but
    // never saw u2.
    const next = [m("u1", "user"), m("a1", "assistant"), m("a2", "assistant")];
    const merged = preserveOptimisticUserMessages(prev, next);
    expect(merged.map((x) => x.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("keeps relative order of a run of consecutive missing user turns", () => {
    const prev = [m("a1", "assistant"), m("u1", "user"), m("u2", "user")];
    const next = [m("a1", "assistant")];
    const merged = preserveOptimisticUserMessages(prev, next);
    expect(merged.map((x) => x.id)).toEqual(["a1", "u1", "u2"]);
  });

  it("prepends a missing user turn that has no surviving predecessor", () => {
    const prev = [m("u1", "user"), m("a1", "assistant")];
    const next = [m("a1", "assistant")];
    const merged = preserveOptimisticUserMessages(prev, next);
    expect(merged.map((x) => x.id)).toEqual(["u1", "a1"]);
  });

  it("never re-adds non-user messages the reducer dropped", () => {
    const prev = [m("a1", "assistant"), m("t1", "tool")];
    const next = [m("a1", "assistant")];
    expect(preserveOptimisticUserMessages(prev, next)).toBe(next);
  });
});
