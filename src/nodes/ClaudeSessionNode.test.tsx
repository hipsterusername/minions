import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";

import { ClaudeSessionRenderer, type ClaudeSessionData } from "./ClaudeSessionNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import type { ServerMessage } from "../use-socket.ts";
import {
  createReplaySocket,
  loadFixture,
  type FixtureEntry,
} from "../../tests/harness/ws-replay.ts";

// jsdom doesn't ship ResizeObserver. Give the renderer a no-op so
// mounting doesn't blow up.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

interface ProbeProps {
  socket: ReturnType<typeof createReplaySocket>["socket"];
  initial: ClaudeSessionData;
  onState?: (d: ClaudeSessionData) => void;
}

/**
 * Stateful wrapper that holds ClaudeSessionData and re-renders the node
 * on each `onUpdateData`. Mirrors how Canvas hosts a node in production.
 *
 * The WS replay is synchronous, so every `onUpdateData` call in the
 * subscription lands on the *same* `dataRef.current` snapshot. The
 * wrapper re-renders after React flushes, but rapid-fire events within
 * one replay tick all observe the same pre-render state. The renderer's
 * subscription handles this correctly in production (each WS frame is a
 * separate React batch); tests here observe the node's *applied* deltas
 * via the `states` array rather than the final merged state, so the
 * last-writer-wins behavior of synchronous replay does not mask bugs.
 */
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
      /* no-op — the renderer may call sync_session on mount */
    },
  };
  return <ClaudeSessionRenderer {...props} />;
}

/**
 * Drive fixture entries one at a time, letting React flush between each.
 *
 * ClaudeSessionNode's subscription reads `dataRef.current` at the top of
 * each handler, and that ref is only refreshed on render. Synchronous
 * replay of a burst of events would leave every handler seeing the same
 * stale snapshot. Flushing after each entry mirrors how WS frames arrive
 * in production (each frame is its own React task).
 */
async function pump(
  replay: (entries: ReadonlyArray<FixtureEntry>) => Promise<void>,
  entries: ReadonlyArray<FixtureEntry>,
): Promise<void> {
  for (const entry of entries) {
    await act(async () => {
      await replay([entry]);
    });
  }
}

function makeInitialData(
  overrides: Partial<ClaudeSessionData> = {},
): ClaudeSessionData {
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
    ...overrides,
  };
}

describe("ClaudeSessionNode: replays claude-session-basic fixture", () => {
  it("captures cost/turns and collapses the wrap-up assistant into result", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("claude-session-basic.jsonl");
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, entries);

    const last = states.at(-1);
    expect(last).toBeDefined();
    if (!last) return;

    expect(last.totalCost).toBe(0.0061);
    expect(last.turns).toBe(1);

    expect(last.status).toBe("idle");

    expect(last.streamingText).toBe("");

    expect(last.promptSuggestions).toEqual([]);
  });

  it("builds the message feed with the correct role sequence", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("claude-session-basic.jsonl");
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, entries);

    const last = states.at(-1);
    if (!last) throw new Error("no state captured");

    expect(last.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "result",
    ]);

    expect(last.messages[0]?.content).toBe("Session on claude-opus-4-5");

    const result = last.messages.find((m) => m.role === "result");
    expect(result?.content).toBe(
      "Three top-level entries: src, README.md, package.json.",
    );
    expect(result?.meta?.isError).toBeUndefined();
  });
});


describe("ClaudeSessionNode: session_status and session_error", () => {
  it("session_status='stopped' sets status without touching messages", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "session_status",
          sessionKey: "session-1",
          status: "stopped",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("stopped");
    expect(last?.error).toBeNull();
    expect(last?.messages).toEqual([]);
  });

  it("session_error flips status to 'error' and captures the message", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "session_error",
          sessionKey: "session-1",
          error: "upstream 503",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("upstream 503");
  });
});


describe("ClaudeSessionNode: ignores messages for other sessionKeys", () => {
  it("does not call onUpdateData for sdk_event with mismatched sessionKey", async () => {
    const { socket, replay } = createReplaySocket();
    const onState = vi.fn();

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={onState}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "some-other-session",
          event: { kind: "text", text: "noise", role: "assistant" },
        },
      },
    ]);

    expect(onState).not.toHaveBeenCalled();
  });
});


describe("ClaudeSessionNode: sync_response !found disconnects", () => {
  it("sets status='disconnected' when server reports !found", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({ status: "running" })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sync_response",
          sessionKey: "session-1",
          found: false,
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("disconnected");
  });
});


describe("ClaudeSessionNode: message kind coverage", () => {
  it("done/error produces a result message with meta.isError=true", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "done", reason: "error", error: "upstream failure" },
        },
      } as FixtureEntry,
    ]);

    const last = states.at(-1);
    const errMsg = last?.messages.find((m) => m.role === "result");
    expect(errMsg?.content).toBe("upstream failure");
    // meta.isError must be true so ResultBubble renders with error styling
    expect((errMsg as { meta?: { isError?: boolean } } | undefined)?.meta?.isError).toBe(true);
  });

  it("permission_denial produces a system message containing the tool name", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "permission_denial", tool: "Bash", reason: "not allowed" },
        },
      } as FixtureEntry,
    ]);

    const last = states.at(-1);
    const sysMsg = last?.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toContain("Bash");
  });

  it("thinking events do NOT appear in the message feed", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "thinking", text: "internal reasoning" },
        },
      } as FixtureEntry,
    ]);

    // thinking events should be silently dropped from the feed
    // (ClaudeSessionNode deliberately skips them)
    const last = states.at(-1);
    expect(last).toBeUndefined(); // no state update at all for thinking events
  });

  it("api_retry events do NOT appear in the message feed", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "api_retry", attempt: 1, reason: "timeout" },
        },
      } as FixtureEntry,
    ]);

    // api_retry handled by status banners, not feed — no feed message produced, no state update
    expect(states).toHaveLength(0);
  });

  it("rate_limit events do NOT appear in the message feed", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "rate_limit", retryAfterMs: 5000 },
        },
      } as FixtureEntry,
    ]);

    // rate_limit handled by status banners, not feed — no state update
    expect(states).toHaveLength(0);
  });
});


/**
 * Helper: pump events through replay then flush any pending RAF/timer frames
 * that `emitStreamingUpdate` schedules. We use fake timers so the 16ms
 * fallback setTimeout fires synchronously inside `act`.
 */
async function pumpAndFlushFrames(
  replay: (entries: ReadonlyArray<FixtureEntry>) => Promise<void>,
  entries: ReadonlyArray<FixtureEntry>,
): Promise<void> {
  await pump(replay, entries);
  // Flush the RAF/setTimeout scheduled by emitStreamingUpdate.
  await act(async () => {
    vi.runAllTimers();
  });
}

describe("ClaudeSessionNode: streaming delta handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("text_delta events accumulate into streamingText", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    await pumpAndFlushFrames(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "text_delta", text: "Hello", blockIndex: 0 },
        },
      } as FixtureEntry,
    ]);
    await pumpAndFlushFrames(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "text_delta", text: " world", blockIndex: 0 },
        },
      } as FixtureEntry,
    ]);

    const last = states.at(-1);
    expect(last?.streamingText).toBe("Hello world");
  });

  it("text_delta with a new blockIndex resets the streaming buffer", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({ streamingText: "block0", streamingBlockIndex: 0 })}
        onState={(d) => states.push(d)}
      />,
    );

    await pumpAndFlushFrames(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          // blockIndex 2 is a new block — must reset buffer
          event: { kind: "text_delta", text: "fresh", blockIndex: 2 },
        },
      } as FixtureEntry,
    ]);

    const last = states.at(-1);
    expect(last?.streamingText).toBe("fresh");
    expect(last?.streamingBlockIndex).toBe(2);
  });

  it("text_delta with parentId (sub-agent) is ignored", async () => {
    const { socket, replay } = createReplaySocket();
    const onState = vi.fn();

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={onState}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "text_delta", text: "sub-agent noise", blockIndex: 0, parentId: "task-xyz" },
        },
      } as FixtureEntry,
    ]);

    // Sub-agent deltas must not update state at all
    expect(onState).not.toHaveBeenCalled();
  });

  it("stream_end clears the streaming buffer", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({ streamingText: "partial...", streamingBlockIndex: 0 })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "stream_end" },
        },
      } as FixtureEntry,
    ]);

    const last = states.at(-1);
    expect(last?.streamingText).toBe("");
    expect(last?.streamingBlockIndex).toBeNull();
  });

  it("a complete assistant text event clears the streaming buffer", async () => {
    const { socket, replay } = createReplaySocket();
    const states: ClaudeSessionData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({ streamingText: "streaming...", streamingBlockIndex: 0 })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          event: { kind: "text", text: "Complete message.", role: "assistant" },
        },
      } as FixtureEntry,
    ]);

    const last = states.at(-1);
    expect(last?.streamingText).toBe("");
    expect(last?.streamingBlockIndex).toBeNull();
    // The complete message appears in the feed
    expect(last?.messages.some((m) => m.role === "assistant" && m.content === "Complete message.")).toBe(true);
  });
});
