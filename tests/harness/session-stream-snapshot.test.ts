/**
 * End-to-end fixture-replay coverage for `sessionStreamReducer`.
 *
 * For every fixture in `tests/fixtures/sdk-message-streams/`, this file
 * replays the recorded ServerMessages through the reducer in order and
 * asserts properties of the cumulative state — role sequence, content
 * strings, cost, turn counts, and per-step intermediate buffer states.
 *
 * Fixtures use NormalizedEvent format. The `sdk_event` wire message carries
 * `event: NormalizedEvent`; completion uses separate `usage` and `done` events.
 *
 * Stability: volatile DisplayMessage fields (`id`, `timestamp`) are
 * stripped before assertion so reruns produce identical output.
 */

import { describe, expect, it } from "vitest";

import { type DisplayMessage } from "../../src/sdk-messages.ts";
import {
  emptySessionStreamState,
  sessionStreamReducer,
  type SessionStreamState,
} from "../../src/session-stream.ts";
import { loadFixture } from "./ws-replay.ts";

/** The snapshot-friendly view of state — strips volatile message fields. */
interface StableSnapshot {
  sessionKey: string | null;
  status: string;
  streamingText: string;
  totalCost: number;
  turns: number;
  error: string | null;
  messages: Omit<DisplayMessage, "id" | "timestamp">[];
}

function stableView(s: SessionStreamState): StableSnapshot {
  return {
    sessionKey: s.sessionKey,
    status: s.status,
    streamingText: s.streamingText,
    totalCost: s.totalCost,
    turns: s.turns,
    error: s.error,
    messages: s.messages.map(({ id: _id, timestamp: _ts, ...rest }) => rest),
  };
}

/**
 * Pick the sessionKey from the first fixture entry and seed the state
 * with it so subsequent sdk_event messages are not filtered out.
 */
function replayFixtureToFinalState(relativePath: string): SessionStreamState {
  const entries = loadFixture(relativePath);
  if (entries.length === 0) {
    throw new Error(`Fixture ${relativePath} is empty`);
  }
  const first = entries[0]?.message;
  if (!first || !("sessionKey" in first) || typeof first.sessionKey !== "string") {
    throw new Error(`Fixture ${relativePath} first entry has no sessionKey`);
  }
  let state = emptySessionStreamState(first.sessionKey);
  // The fixture starts with the session already running — set status
  // accordingly so the reducer doesn't ignore early sdk_events.
  state = { ...state, status: "running" };
  for (const entry of entries) {
    state = sessionStreamReducer(state, entry.message, "test");
  }
  return state;
}

describe("sessionStreamReducer: snapshot baseline against fixtures", () => {
  it("leader-thinking-and-text.jsonl", () => {
    const final = replayFixtureToFinalState("leader-thinking-and-text.jsonl");
    const view = stableView(final);
    // The single assistant message produced 3 DisplayMessages (thinking,
    // text, tool); the result that follows has DIFFERENT content
    // ("Read complete.") so no collapse happens.
    expect(view.messages.map((m) => m.role)).toEqual([
      "system",
      "thinking",
      "assistant",
      "tool",
      "result",
    ]);
    expect(view.totalCost).toBe(0.0042);
    expect(view.turns).toBe(1);
    expect(view.streamingText).toBe("");
  });

  it("leader-stream-then-final.jsonl: streaming deltas accumulate then clear on assistant", () => {
    // Replay entries step by step to observe intermediate buffer states.
    // Fixture layout:
    //   [0] init
    //   [1] text_delta "Hello"
    //   [2] text_delta " world"
    //   [3] usage (no costUSD — pre-stop, does not clear buffer)
    //   [4] text "Hello world" (complete assistant — clears buffer)
    //   [5] usage (costUSD:0.0009 — session cost)
    //   [6] done "Hello world" (collapses the matching assistant)
    const entries = loadFixture("leader-stream-then-final.jsonl");
    let s = emptySessionStreamState("leader-1");
    s = { ...s, status: "running" };
    // [0] init
    s = sessionStreamReducer(s, entries[0]!.message, "test");
    // [1,2] stream deltas
    s = sessionStreamReducer(s, entries[1]!.message, "test");
    s = sessionStreamReducer(s, entries[2]!.message, "test");
    expect(s.streamingText).toBe("Hello world");
    // [3] pre-stop usage (no costUSD) — buffer must NOT clear here.
    s = sessionStreamReducer(s, entries[3]!.message, "test");
    expect(s.streamingText).toBe("Hello world");
    // [4] final assistant — clears the buffer.
    s = sessionStreamReducer(s, entries[4]!.message, "test");
    expect(s.streamingText).toBe("");
    expect(s.messages.map((m) => m.content)).toEqual([
      "Session on claude-opus-4-5",
      "Hello world",
    ]);
    // [5] usage with costUSD — updates totalCost only, does NOT collapse.
    s = sessionStreamReducer(s, entries[5]!.message, "test");
    expect(s.totalCost).toBe(0.0009);
    expect(s.messages.map((m) => m.role)).toEqual(["system", "assistant"]);
    // [6] done — collapses the matching assistant, adds result.
    s = sessionStreamReducer(s, entries[6]!.message, "test");
    expect(s.messages.map((m) => m.role)).toEqual(["system", "result"]);
  });

  it("minion-completes-task.jsonl: result collapses no assistant (tool-driven turn)", () => {
    const final = replayFixtureToFinalState("minion-completes-task.jsonl");
    const view = stableView(final);
    // The minion's final report comes from `mcp__minion__report_done`
    // (a tool message), not an assistant text matching the result. So
    // no collapse — assistant text + tool calls + tool_progress + result
    // all present.
    expect(view.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "tool",
      "result",
    ]);
    expect(view.totalCost).toBe(0.0114);
    expect(view.turns).toBe(3);
  });

  it("leader-multi-text-blocks.jsonl: live preview never mashes non-adjacent text blocks", () => {
    // Regression for the live-streaming bug:
    //   • Text blocks separated by tool_use must not concatenate without a
    //     separator into "Let me check the file.Now I'll edit…"
    //   • Sub-agent (`Agent`/`Task` tool) deltas must not interleave with the
    //     parent's preview even though they share the same sessionKey.
    //   • `message_delta` must not flush the buffer before the final assistant.
    // This fixture and walk-through pin the corrected behaviour.
    //
    // Fixture layout (18 entries, 0-indexed):
    //   [0]  init
    //   [1]  text_delta ""    blockIndex=0  (content_block_start, empty seed)
    //   [2]  text_delta "Let me check "  blockIndex=0
    //   [3]  text_delta "the file."  blockIndex=0
    //   [4]  text_delta " SUBAGENT-LEAK"  blockIndex=0  parentId=... (filtered)
    //   [5..8]  usage no-costUSD x4  (no-ops)
    //   [9]  text_delta ""    blockIndex=2  (block boundary reset)
    //   [10] text_delta "Now I'll edit "  blockIndex=2
    //   [11] text_delta "the file."  blockIndex=2
    //   [12] usage no-costUSD  (no-op)
    //   [13] usage no-costUSD  (no-op)
    //   [14] stream_end  (clears buffer)
    //   [15] text "Let me check the file."  (first complete text block)
    //   [16] tool_call "Read"  (tool block)
    //   [17] text "Now I'll edit the file."  (second complete text block)
    const entries = loadFixture("leader-multi-text-blocks.jsonl");
    let s = emptySessionStreamState("leader-1");
    s = { ...s, status: "running" };

    // [0] system init — system bubble appears, no streaming yet.
    s = sessionStreamReducer(s, entries[0]!.message, "test");
    expect(s.streamingText).toBe("");
    expect(s.streamingBlockIndex).toBeNull();

    // [1] content_block_start index=0 (text) — buffer locks to block 0.
    s = sessionStreamReducer(s, entries[1]!.message, "test");
    expect(s.streamingBlockIndex).toBe(0);
    expect(s.streamingText).toBe("");

    // [2,3] block 0 deltas accumulate.
    s = sessionStreamReducer(s, entries[2]!.message, "test");
    s = sessionStreamReducer(s, entries[3]!.message, "test");
    expect(s.streamingText).toBe("Let me check the file.");
    expect(s.streamingBlockIndex).toBe(0);

    // [4] sub-agent delta (parentId non-null) — must be dropped.
    const beforeSub = s;
    s = sessionStreamReducer(s, entries[4]!.message, "test");
    expect(s).toBe(beforeSub);
    expect(s.streamingText).toBe("Let me check the file.");

    // [5..8] usage no-ops — buffer untouched.
    s = sessionStreamReducer(s, entries[5]!.message, "test");
    s = sessionStreamReducer(s, entries[6]!.message, "test");
    s = sessionStreamReducer(s, entries[7]!.message, "test");
    s = sessionStreamReducer(s, entries[8]!.message, "test");
    expect(s.streamingText).toBe("Let me check the file.");
    expect(s.streamingBlockIndex).toBe(0);

    // [9] content_block_start index=2 (text) — block boundary RESETS the
    // buffer to this block's content (empty initial text). Without this
    // reset the next deltas would concatenate onto block 0's text.
    s = sessionStreamReducer(s, entries[9]!.message, "test");
    expect(s.streamingText).toBe("");
    expect(s.streamingBlockIndex).toBe(2);

    // [10,11] block 2 deltas — accumulate cleanly with no block-0 leakage.
    s = sessionStreamReducer(s, entries[10]!.message, "test");
    s = sessionStreamReducer(s, entries[11]!.message, "test");
    expect(s.streamingText).toBe("Now I'll edit the file.");
    expect(s.streamingBlockIndex).toBe(2);

    // [12,13] usage no-ops — buffer survives.
    s = sessionStreamReducer(s, entries[12]!.message, "test");
    s = sessionStreamReducer(s, entries[13]!.message, "test");
    expect(s.streamingText).toBe("Now I'll edit the file.");
    expect(s.streamingBlockIndex).toBe(2);

    // [14] stream_end — clears the buffer.
    s = sessionStreamReducer(s, entries[14]!.message, "test");
    expect(s.streamingText).toBe("");
    expect(s.streamingBlockIndex).toBeNull();

    // [15,16,17] text + tool_call + text — three separate DisplayMessages.
    s = sessionStreamReducer(s, entries[15]!.message, "test");
    s = sessionStreamReducer(s, entries[16]!.message, "test");
    s = sessionStreamReducer(s, entries[17]!.message, "test");
    expect(s.streamingText).toBe("");
    const stable = s.messages.map(({ id: _i, timestamp: _t, ...rest }) => rest);
    expect(stable.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stable.map((m) => m.content)).toEqual([
      "Session on claude-opus-4-5",
      "Let me check the file.",
      "Read",
      "Now I'll edit the file.",
    ]);
  });

  it("claude-session-basic.jsonl: the wrap-up assistant matches the result and collapses", () => {
    const final = replayFixtureToFinalState("claude-session-basic.jsonl");
    const view = stableView(final);
    // Fixture: init → text "I'll run ls." → tool_call Bash →
    // tool_progress Bash → text "Three top-level..." → usage → done.
    // The wrap-up assistant matches the result → collapses.
    expect(view.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant", // "I'll run ls."
      "tool",      // Bash (tool_call)
      "tool",      // Bash (tool_progress 0.4s)
      "result",    // collapsed wrap-up
    ]);
    expect(view.totalCost).toBe(0.0061);
  });
});
