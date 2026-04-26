/**
 * End-to-end snapshot baseline for `sessionStreamReducer`.
 *
 * For every fixture in `tests/fixtures/sdk-message-streams/`, this file
 * replays the recorded ServerMessages through the reducer in order and
 * asserts the *final* state matches an inline snapshot.
 *
 * **Why this complements `sdk-messages-snapshot.test.ts`:** that file
 * locks the per-event conversion. This one locks the cumulative
 * reducer behaviour — dedup, streaming clear, assistant/result
 * collapse, cost/turns capture across a full stream. Both must stay
 * green for SessionHost extraction to land safely.
 *
 * Stability: volatile DisplayMessage fields (`id`, `timestamp`) are
 * stripped before snapshotting so reruns produce identical output.
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
  it("leader-plan-and-delegate.jsonl", () => {
    const final = replayFixtureToFinalState("leader-plan-and-delegate.jsonl");
    expect(stableView(final)).toMatchInlineSnapshot(`
      {
        "error": null,
        "messages": [
          {
            "content": "Session on claude-opus-4-5",
            "role": "system",
            "sdkUuid": "u-init-0001",
          },
          {
            "content": "Two independent tasks. I'll plan both, then delegate the first to a minion.",
            "role": "thinking",
            "sdkUuid": "u-asst-0002",
          },
          {
            "content": "I'll plan the two tasks and delegate the first.",
            "role": "assistant",
            "sdkUuid": "u-asst-0003",
          },
          {
            "content": "mcp__task-manager__set_task_name",
            "role": "tool",
            "sdkUuid": "u-asst-0004",
            "toolInput": {
              "name": "Plan and delegate",
            },
            "toolName": "mcp__task-manager__set_task_name",
          },
          {
            "content": "mcp__task-manager__plan_task",
            "role": "tool",
            "sdkUuid": "u-asst-0005",
            "toolInput": {
              "description": "Do the first thing",
              "priority": "high",
              "taskId": "task-a",
              "title": "First task",
            },
            "toolName": "mcp__task-manager__plan_task",
          },
          {
            "content": "mcp__task-manager__plan_task",
            "role": "tool",
            "sdkUuid": "u-asst-0006",
            "toolInput": {
              "description": "Do the second thing",
              "priority": "medium",
              "taskId": "task-b",
              "title": "Second task",
            },
            "toolName": "mcp__task-manager__plan_task",
          },
          {
            "content": "mcp__task-manager__assign_task",
            "role": "tool",
            "sdkUuid": "u-asst-0007",
            "toolInput": {
              "prompt": "Do the first thing",
              "taskId": "task-a",
            },
            "toolName": "mcp__task-manager__assign_task",
          },
          {
            "content": "Delegated \`task-a\` to a minion. I'll handle \`task-b\` myself next.",
            "role": "assistant",
            "sdkUuid": "u-asst-0008",
          },
          {
            "content": "Planned 2 tasks and delegated 1.",
            "role": "result",
            "sdkUuid": "u-result-0009",
            "suffix": "8.6s · $0.0288",
          },
        ],
        "sessionKey": "leader-1",
        "status": "running",
        "streamingText": "",
        "totalCost": 0.0288,
        "turns": 1,
      }
    `);
  });

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

// ── Sync-response replay ─────────────────────────────────

describe("sessionStreamReducer: sync_response replay rebuilds same final state", () => {
  it("rebuilding via sync_response produces the same messages as live replay", () => {
    // Live replay
    const liveEntries = loadFixture("leader-plan-and-delegate.jsonl");
    const live = liveEntries.reduce(
      (acc, entry) => sessionStreamReducer(acc, entry.message, "test"),
      { ...emptySessionStreamState("leader-1"), status: "running" as const },
    );

    // Sync-response replay: bundle every sdk_event into a single
    // sync_response and run it through the reducer once.
    const syncEvents = liveEntries
      .map((e) => e.message)
      .filter((m): m is Extract<typeof m, { type: "sdk_event" }> => m.type === "sdk_event")
      .map((m) => ({
        type: "sdk_event" as const,
        sessionKey: m.sessionKey,
        message: m.message,
        timestamp: 0,
      }));

    const synced = sessionStreamReducer(
      { ...emptySessionStreamState("leader-1"), status: "running" },
      {
        type: "sync_response",
        sessionKey: "leader-1",
        found: true,
        status: "running",
        events: syncEvents,
      },
      "test",
    );

    // Same content (volatile fields stripped).
    const liveStable = live.messages.map(({ id: _i, timestamp: _t, ...rest }) => rest);
    const syncStable = synced.messages.map(({ id: _i, timestamp: _t, ...rest }) => rest);
    expect(syncStable).toEqual(liveStable);
    expect(synced.totalCost).toBe(live.totalCost);
    expect(synced.turns).toBe(live.turns);
  });
});
