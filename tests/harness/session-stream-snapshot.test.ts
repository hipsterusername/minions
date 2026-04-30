/**
 * End-to-end fixture-replay coverage for `sessionStreamReducer`.
 *
 * For every fixture in `tests/fixtures/sdk-message-streams/`, this file
 * replays the recorded ServerMessages through the reducer in order and
 * asserts properties of the cumulative state — role sequence, content
 * strings, cost, turn counts, and per-step intermediate buffer states.
 *
 * **Status (post-§2.5 rewrite):** the prior version of this file used
 * inline `toMatchInlineSnapshot` blobs. Per
 * `docs/testing-strategy.md` §5.6, those have been replaced with
 * targeted property assertions. The companion
 * `tests/harness/sdk-messages-snapshot.test.ts` was deleted in the
 * same pass — it duplicated the leader-plan-and-delegate fixture this
 * file already exercises, and the reducer-determinism tautology it
 * also carried (`sync_response replay yields the same state`) has been
 * removed per §5.1.
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
  // Note: the leader-plan-and-delegate fixture is now exercised by
  // tests/harness/sdk-messages-snapshot.test.ts (after the §2.4 rewrite).
  // Keeping a duplicate here violates §5.9 (DUPLICATE).

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
    // Replay only the system + 3 stream_event partials so we can observe
    // the intermediate streaming buffer state.
    const entries = loadFixture("leader-stream-then-final.jsonl");
    let s = emptySessionStreamState("leader-1");
    s = { ...s, status: "running" };
    // init
    s = sessionStreamReducer(s, entries[0]!.message, "test");
    // stream deltas
    s = sessionStreamReducer(s, entries[1]!.message, "test");
    s = sessionStreamReducer(s, entries[2]!.message, "test");
    expect(s.streamingText).toBe("Hello world");
    // message_delta — pre-stop usage update; buffer must NOT clear here.
    // (Historic behaviour cleared on message_delta, causing the live
    // preview to flicker out a tick before the final assistant arrived.)
    s = sessionStreamReducer(s, entries[3]!.message, "test");
    expect(s.streamingText).toBe("Hello world");
    // final assistant — clears the buffer.
    s = sessionStreamReducer(s, entries[4]!.message, "test");
    expect(s.streamingText).toBe("");
    expect(s.messages.map((m) => m.content)).toEqual([
      "Session on claude-opus-4-5",
      "Hello world",
    ]);
    // result with content matching the assistant — collapse should drop
    // the assistant bubble.
    s = sessionStreamReducer(s, entries[5]!.message, "test");
    expect(s.messages.map((m) => m.role)).toEqual(["system", "result"]);
    expect(s.totalCost).toBe(0.0009);
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
    //   • A single assistant message with content [text, tool_use, text]
    //     used to stream the two text blocks into one buffer with no
    //     separator, producing "Let me check the file.Now I'll edit…"
    //   • Sub-agent (`Agent`/`Task` tool) deltas used to interleave with
    //     the parent's preview because they share the same sessionKey.
    //   • `message_delta` used to be treated as stream end and flushed
    //     the buffer one tick before the final assistant arrived.
    // This fixture and walk-through pin the corrected behaviour.
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

    // [4] sub-agent delta (parent_tool_use_id non-null) — must be dropped.
    const beforeSub = s;
    s = sessionStreamReducer(s, entries[4]!.message, "test");
    expect(s).toBe(beforeSub);
    expect(s.streamingText).toBe("Let me check the file.");

    // [5] content_block_stop index=0 — no-op for the reducer.
    s = sessionStreamReducer(s, entries[5]!.message, "test");
    expect(s.streamingText).toBe("Let me check the file.");

    // [6,7,8] tool_use start / input_json_delta / stop — buffer untouched.
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

    // [12] content_block_stop index=2 — no-op.
    s = sessionStreamReducer(s, entries[12]!.message, "test");
    expect(s.streamingText).toBe("Now I'll edit the file.");

    // [13] message_delta — pre-stop usage update; buffer survives.
    s = sessionStreamReducer(s, entries[13]!.message, "test");
    expect(s.streamingText).toBe("Now I'll edit the file.");
    expect(s.streamingBlockIndex).toBe(2);

    // [14] message_stop — clears the buffer.
    s = sessionStreamReducer(s, entries[14]!.message, "test");
    expect(s.streamingText).toBe("");
    expect(s.streamingBlockIndex).toBeNull();

    // [15] final assistant — produces three separate DisplayMessages
    // (text, tool, text) — one per content block.
    s = sessionStreamReducer(s, entries[15]!.message, "test");
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
    // The assistant wrap-up text and the result text are identical, so
    // the assistant should collapse. The earlier "I'll run ls." assistant
    // is left intact (different content).
    expect(view.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant", // "I'll run ls."
      "tool",      // Bash
      "tool",      // Bash (0.4s)
      "system",    // tool_use_summary
      "result",    // collapsed wrap-up
    ]);
    expect(view.totalCost).toBe(0.0061);
  });
});

// Note: a "sync_response replay rebuilds same final state" describe block
// lived here. Per testing-strategy.md §5.1 (TAUTOLOGY) it has been removed —
// the reducer is deterministic over identical input, so feeding it the same
// events twice is guaranteed to yield equal state by construction.
