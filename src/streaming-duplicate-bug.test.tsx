/**
 * Repro tests for the duplicate-text bug in the chat UI.
 *
 * Symptom (per user report): assistant text occasionally appears twice
 * in the chat feed — both during the live preview (`streamingText`)
 * and after the message is committed.
 *
 * The shared `sessionStreamReducer` is well-covered and dedups by
 * content-derived ID (see `src/session-stream.test.ts` "dedups by id"). The
 * ad-hoc subscription in {@link import("./nodes/ClaudeSessionNode")}
 * does NOT use the shared reducer; it has its own
 * `normalizedToSessionMessages` that mints a fresh `crypto.randomUUID()`
 * for every produced message, and appends without deduplicating by
 * content.
 *
 * This file pins the difference behaviorally:
 *
 *   1. The shared reducer is robust to duplicate sdk_event delivery.
 *   2. ClaudeSessionNode's renderer is NOT — re-delivering the same
 *      assistant event produces a duplicate bubble.
 *   3. Burst delivery of stream deltas + a complete assistant within
 *      one tick (a likely real-world race) is handled correctly by
 *      the shared reducer.
 *
 * These tests are not snapshot baselines; they are red-flag detectors.
 * Test (2) is intentionally a "captures the current bug" test — when
 * the underlying issue is fixed, the assertion can be flipped from
 * "two assistant bubbles" to "one assistant bubble" and the bug fix
 * stays regression-locked.
 */

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import {
  emptySessionStreamState,
  sessionStreamReducer,
  type SessionStreamState,
} from "./session-stream.ts";
import type { ServerMessage } from "./use-socket.ts";
import type { NormalizedEvent } from "../shared/normalized-event.ts";
import {
  ClaudeSessionRenderer,
  type ClaudeSessionData,
} from "./nodes/ClaudeSessionNode.tsx";
import { findDuplicateContent } from "./debug.ts";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";
import type { CanvasNode, NodeRenderProps } from "./types.ts";
import { createReplaySocket } from "../tests/harness/ws-replay.ts";

// jsdom doesn't ship ResizeObserver — give the renderer a no-op.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

// ── Builders ────────────────────────────────────────────

function assistantEvent(text: string): NormalizedEvent {
  return { kind: "text", text, role: "assistant" };
}

function streamDelta(text: string, index = 0): NormalizedEvent {
  return { kind: "text_delta", text, blockIndex: index };
}

function streamStop(): NormalizedEvent {
  return { kind: "stream_end" };
}

function sdkEnvelope(event: NormalizedEvent): ServerMessage {
  return { type: "sdk_event", sessionKey: "session-1", event };
}

function freshState(
  overrides: Partial<SessionStreamState> = {},
): SessionStreamState {
  return {
    ...emptySessionStreamState("session-1"),
    status: "running",
    ...overrides,
  };
}

// ── Path 1: shared reducer — robust ─────────────────────

describe("sessionStreamReducer is robust to duplicate / interleaved events", () => {
  it("dedups when the same complete assistant arrives twice", () => {
    const evt = sdkEnvelope(assistantEvent("Hello world"));
    let s = freshState();
    s = sessionStreamReducer(s, evt, "x");
    s = sessionStreamReducer(s, evt, "x");
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(findDuplicateContent(s.messages)).toEqual([]);
  });

  it("handles a burst of deltas followed by the same-content complete assistant", () => {
    let s = freshState();
    s = sessionStreamReducer(s, sdkEnvelope(streamDelta("Hello", 0)), "x");
    s = sessionStreamReducer(s, sdkEnvelope(streamDelta(" world", 0)), "x");
    expect(s.streamingText).toBe("Hello world");
    s = sessionStreamReducer(s, sdkEnvelope(streamStop()), "x");
    expect(s.streamingText).toBe("");
    s = sessionStreamReducer(s, sdkEnvelope(assistantEvent("Hello world")), "x");
    expect(s.messages).toHaveLength(1);
    expect(s.streamingText).toBe("");
    expect(findDuplicateContent(s.messages)).toEqual([]);
  });

  it("handles a sync_response that re-delivers events already in messages", () => {
    let s = freshState();
    const event = assistantEvent("Hello world");
    s = sessionStreamReducer(s, sdkEnvelope(event), "x");
    expect(s.messages).toHaveLength(1);

    // Server replays same content via sync_response — must not double-up.
    s = sessionStreamReducer(
      s,
      {
        type: "sync_response",
        sessionKey: "session-1",
        found: true,
        events: [
          { type: "sdk_event", sessionKey: "session-1", event, timestamp: 0 },
        ],
      },
      "x",
    );
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(findDuplicateContent(s.messages)).toEqual([]);
  });
});

// ── Path 2: ClaudeSessionNode ad-hoc reducer — pins the bug ──

interface ProbeProps {
  socket: ReturnType<typeof createReplaySocket>["socket"];
  initial: ClaudeSessionData;
  onState?: (d: ClaudeSessionData) => void;
}

function Probe({ socket, initial, onState }: ProbeProps) {
  const [data, setData] = useState<ClaudeSessionData>(initial);
  const node: CanvasNode = {
    id: "claude-session-test",
    type: "claude-session",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 400 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => {
      const nextData = next as ClaudeSessionData;
      setData(nextData);
      onState?.(nextData);
    },
    socketSubscribe: socket.subscribe,
    socketSend: () => {
      /* no-op */
    },
  };
  return <ClaudeSessionRenderer {...props} />;
}

function makeInitial(): ClaudeSessionData {
  return {
    sessionKey: "session-1",
    status: "running",
    messages: [],
    streamingText: "",
    totalCost: 0,
    turns: 0,
    error: null,
    model: "sonnet",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...DEFAULT_THINKING_CONFIG },
    lastDurationMs: null,
    subagents: [],
    promptSuggestions: [],
    initData: null,
  };
}

describe("ClaudeSessionNode: duplicate-text bug pinning", () => {
  it("DOES duplicate when the same assistant event is delivered twice", async () => {
    // Bug capture: ClaudeSessionNode's `normalizedToSessionMessages`
    // generates a fresh crypto.randomUUID() per message and the
    // subscription appends with no content-based dedup. So re-delivery
    // of the same NormalizedEvent produces two assistant bubbles with
    // different display IDs but identical content.
    //
    // NOTE: when this is fixed (e.g. by switching to the shared
    // reducer or deriving stable IDs from content), flip this assertion
    // to `toHaveLength(1)` and the regression net catches a future
    // backslide.
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];
    render(
      <Probe
        socket={socket}
        initial={makeInitial()}
        onState={(d) => states.push(d)}
      />,
    );

    const evt = {
      message: sdkEnvelope(assistantEvent("Hello world")),
    };
    await act(async () => {
      await replay([evt]);
    });
    await act(async () => {
      await replay([evt]);
    });

    const last = states.at(-1);
    expect(last).toBeDefined();
    if (!last) return;
    const assistantBubbles = last.messages.filter(
      (m) => m.role === "assistant" && m.content === "Hello world",
    );
    // BUG: two bubbles. Once fixed, change to exactly 1.
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(2);

    // Duplicate-detector flags it — useful when this test eventually
    // becomes a fix-confirmation test.
    expect(findDuplicateContent(last.messages).length).toBeGreaterThan(0);
  });

  it("clears streamingText when message_stop arrives, even on the ad-hoc reducer", async () => {
    // This pins the live-preview side of the bug: a stale streaming
    // buffer that is never cleared would render alongside the final
    // committed assistant bubble — the user sees the same text twice
    // for as long as the buffer lingers.
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];
    render(
      <Probe
        socket={socket}
        initial={makeInitial()}
        onState={(d) => states.push(d)}
      />,
    );

    await act(async () => {
      await replay([
        { message: sdkEnvelope(streamDelta("Hello", 0)) },
        { message: sdkEnvelope(streamDelta(" world", 0)) },
      ]);
    });
    await act(async () => {
      await replay([{ message: sdkEnvelope(streamStop()) }]);
    });

    const lastAfterStop = states.at(-1);
    expect(lastAfterStop?.streamingText).toBe("");
  });
});
