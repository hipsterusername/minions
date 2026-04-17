/**
 * DOM tests for `useSessionStream`.
 *
 * Mounts a tiny test component that wires the hook to the replay
 * harness and a controlled state, then drives the harness with each
 * fixture and asserts the hook fires `onChange` correctly.
 *
 * Pure-reducer correctness is covered exhaustively in
 * `src/session-stream.test.ts` and the fixture-replay snapshots in
 * `tests/harness/session-stream-snapshot.test.ts`. This file *only*
 * tests the React-integration concerns: subscribe/unsubscribe
 * lifecycle, state-change throttling, prop-stability, and graceful
 * handling of a missing `socketSubscribe`.
 */

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  emptySessionStreamState,
  type SessionStreamState,
} from "./session-stream.ts";
import { useSessionStream } from "./use-session-stream.ts";
import {
  createReplaySocket,
  loadFixture,
  type FixtureEntry,
} from "../tests/harness/ws-replay.ts";

// ── Test harness component ──────────────────────────────

interface ProbeProps {
  socket: ReturnType<typeof createReplaySocket>["socket"];
  initial: SessionStreamState;
  prefix?: string;
  onState?: (s: SessionStreamState) => void;
}

/**
 * Minimal component that wires the hook to a controlled `useState`
 * and forwards every state to the parent's `onState` spy.
 */
function Probe({ socket, initial, prefix = "test", onState }: ProbeProps) {
  const [state, setState] = useState<SessionStreamState>(initial);
  useSessionStream({
    socketSubscribe: socket.subscribe,
    state,
    onChange: (next) => {
      setState(next);
      onState?.(next);
    },
    prefix,
  });
  return <div data-testid="msg-count">{state.messages.length}</div>;
}

/** Convenience: `await act(replay(entries))` so React flushes updates. */
async function pump(
  replay: (entries: ReadonlyArray<FixtureEntry>) => Promise<void>,
  entries: ReadonlyArray<FixtureEntry>,
): Promise<void> {
  await act(async () => {
    await replay(entries);
  });
}

// ── Tests ───────────────────────────────────────────────

describe("useSessionStream: subscribe/unsubscribe lifecycle", () => {
  it("registers exactly one subscriber on mount and removes it on unmount", () => {
    const { socket } = createReplaySocket();
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };

    expect(socket.subscriberCount).toBe(0);
    const view = render(<Probe socket={socket} initial={initial} />);
    expect(socket.subscriberCount).toBe(1);
    view.unmount();
    expect(socket.subscriberCount).toBe(0);
  });

  it("does NOT re-subscribe across re-renders that don't change socketSubscribe", () => {
    const { socket } = createReplaySocket();
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };

    function Wrapper() {
      const [, setN] = useState(0);
      return (
        <>
          <Probe socket={socket} initial={initial} />
          <button data-testid="rerender" onClick={() => setN((n) => n + 1)} />
        </>
      );
    }
    const view = render(<Wrapper />);
    const button = view.getByTestId("rerender");

    expect(socket.subscriberCount).toBe(1);
    act(() => button.click());
    act(() => button.click());
    act(() => button.click());
    expect(socket.subscriberCount).toBe(1);

    view.unmount();
    expect(socket.subscriberCount).toBe(0);
  });

  it("is a no-op when socketSubscribe is undefined", () => {
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };
    const onState = vi.fn();

    function NoSocketProbe() {
      const [state, setState] = useState(initial);
      useSessionStream({
        socketSubscribe: undefined,
        state,
        onChange: (next) => {
          setState(next);
          onState(next);
        },
        prefix: "test",
      });
      return null;
    }

    const view = render(<NoSocketProbe />);
    // No errors, no state changes — nothing to call onChange.
    expect(onState).not.toHaveBeenCalled();
    view.unmount();
  });
});

// ── Drive a real fixture through the hook ─────────────

describe("useSessionStream: drives state via the reducer against fixtures", () => {
  it("replays leader-plan-and-delegate.jsonl into the controlled state", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("leader-plan-and-delegate.jsonl");

    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };
    const states: SessionStreamState[] = [];

    render(
      <Probe
        socket={socket}
        initial={initial}
        onState={(s) => states.push(s)}
      />,
    );

    await pump(replay, entries);

    // 11 fixture entries; every one of them produces a state change in
    // the current shape (system_init → message; assistant blocks →
    // messages; etc.). Some events (session_task_name, session_status
    // for the minion) are filtered out by the reducer because they
    // don't match the leader's sessionKey or aren't handled. So the
    // exact onChange count is between 7 and 11; assert the bounds.
    expect(states.length).toBeGreaterThanOrEqual(7);
    expect(states.length).toBeLessThanOrEqual(11);

    // The final state must carry the result's cost/turns and the full
    // converted message list.
    const last = states.at(-1);
    expect(last?.totalCost).toBe(0.0288);
    expect(last?.turns).toBe(1);
    // 9 DisplayMessages survive: init system + thinking + text +
    // 4× tool_use + assistant + result.
    expect(last?.messages).toHaveLength(9);
    expect(last?.messages.at(-1)?.role).toBe("result");
  });

  it("each onChange callback receives a NEW state reference (no in-place mutation)", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("leader-thinking-and-text.jsonl");
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };
    const states: SessionStreamState[] = [];

    render(
      <Probe
        socket={socket}
        initial={initial}
        onState={(s) => states.push(s)}
      />,
    );

    await pump(replay, entries);

    // No two consecutive states should be the same reference — the
    // hook is supposed to gate onChange on reference inequality.
    for (let i = 1; i < states.length; i++) {
      expect(states[i]).not.toBe(states[i - 1]);
    }
    // And every state's `messages` array must be a fresh array (the
    // reducer never mutates).
    for (let i = 1; i < states.length; i++) {
      const prev = states[i - 1];
      const cur = states[i];
      if (prev && cur && prev.messages.length !== cur.messages.length) {
        expect(cur.messages).not.toBe(prev.messages);
      }
    }
  });

  it("multiple consumers on the same socket each receive every message", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("leader-thinking-and-text.jsonl");
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };
    const a: SessionStreamState[] = [];
    const b: SessionStreamState[] = [];

    render(
      <>
        <Probe socket={socket} initial={initial} onState={(s) => a.push(s)} />
        <Probe socket={socket} initial={initial} onState={(s) => b.push(s)} />
      </>,
    );
    expect(socket.subscriberCount).toBe(2);

    await pump(replay, entries);

    // Both consumers see the same final state shape (volatile fields
    // notwithstanding — but `messages` count and totals must match).
    expect(a.at(-1)?.messages.length).toBe(b.at(-1)?.messages.length);
    expect(a.at(-1)?.totalCost).toBe(b.at(-1)?.totalCost);
    expect(a.at(-1)?.turns).toBe(b.at(-1)?.turns);
  });
});

// ── Reference-equality contract through React ─────────

describe("useSessionStream: respects the reducer's reference-equality contract", () => {
  it("does NOT call onChange when the inbound message is for a different sessionKey", async () => {
    const { socket, replay } = createReplaySocket();
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };
    const onState = vi.fn();

    render(
      <Probe socket={socket} initial={initial} onState={onState} />,
    );

    // Send a stream of messages targeting a different sessionKey.
    await pump(replay, [
      { message: { type: "session_status", sessionKey: "other", status: "idle" } },
      { message: { type: "session_error", sessionKey: "other", error: "x" } },
      {
        message: {
          type: "sdk_event",
          sessionKey: "other",
          message: {
            type: "assistant",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              model: "claude",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            parent_tool_use_id: null,
            uuid: "u",
            session_id: "s",
          },
        },
      },
    ]);

    expect(onState).not.toHaveBeenCalled();
  });

  it("does NOT call onChange when session_status reports the same status", async () => {
    const { socket, replay } = createReplaySocket();
    const initial: SessionStreamState = {
      ...emptySessionStreamState("leader-1"),
      status: "running",
    };
    const onState = vi.fn();

    render(
      <Probe socket={socket} initial={initial} onState={onState} />,
    );

    await pump(replay, [
      { message: { type: "session_status", sessionKey: "leader-1", status: "running" } },
    ]);
    expect(onState).not.toHaveBeenCalled();

    // But a real status change DOES fire onChange.
    await pump(replay, [
      { message: { type: "session_status", sessionKey: "leader-1", status: "idle" } },
    ]);
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0]?.[0].status).toBe("idle");
  });
});
