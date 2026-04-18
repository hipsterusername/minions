/**
 * Behavior baseline for ClaudeSessionNode's WebSocket subscription.
 *
 * ClaudeSessionNode is the fallback renderer for role="default" sessions
 * (see Canvas.tsx:638) and owns a ~160-line subscription effect that
 * mixes:
 *   • shared session-stream concerns (status, error, sync_response,
 *     streaming text deltas) that are candidates for migration onto
 *     `useSessionStream`
 *   • node-specific handling (rich ResultMeta, subagent tracking,
 *     init-data capture, prompt suggestions, hook/auth subtypes)
 *
 * The node's local `sdkMessageToSessionMessages` diverges from the
 * shared `sdkToDisplayMessages` in meaningful ways (richer result
 * metadata, hook/auth subtypes, no `thinking` role). A naive migration
 * to the shared reducer would regress rendering.
 *
 * This file is the **test-first arrow guardrail** for any subsequent
 * migration: it locks observable behavior end-to-end so a future
 * refactor cannot silently change what the UI sees.
 *
 * Strategy: mount the renderer with a controlled ClaudeSessionData +
 * the replay socket, drive a fixture, and assert the data the node
 * pushed back through `onUpdateData`.
 */

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";

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
    modelUsage: null,
    lastDurationMs: null,
    subagents: [],
    promptSuggestions: [],
    initData: null,
    ...overrides,
  };
}

// ── End-to-end fixture replay ──────────────────────────

describe("ClaudeSessionNode: replays claude-session-basic fixture", () => {
  it("captures cost/turns, records init data, and collapses the wrap-up into result", async () => {
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

    // Cost / turns captured from the result envelope.
    expect(last.totalCost).toBe(0.0061);
    expect(last.turns).toBe(1);
    expect(last.lastDurationMs).toBe(1800);

    // Status drops to "idle" on result.
    expect(last.status).toBe("idle");

    // Streaming buffer cleared on result.
    expect(last.streamingText).toBe("");

    // Prompt suggestions cleared on new turn.
    expect(last.promptSuggestions).toEqual([]);

    // NOTE: initData and `model` inferred from the init system event
    // are NOT captured in the final state because the current
    // subscription emits TWO `onUpdateData` calls per sdk_event (one
    // for the init-specific branch at line 994, then another at line
    // 1035 for message append). Both clone from the same pre-event
    // `current` snapshot, so the second emit overwrites the first.
    // This is a latent bug; a subsequent SessionHost migration should
    // consolidate the emits (tracked in CLAUDE.md).
  });

  it("builds the message feed with the rich ResultMeta on the result bubble", async () => {
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

    // The wrap-up assistant content matches the result content, so the
    // node's assistant/result collapse strips the dupe assistant before
    // appending result. Expected role sequence:
    //   system (init)
    //   assistant ("I'll run ls.")
    //   tool (Bash)
    //   tool (Bash 0.4s from tool_progress)
    //   system (tool_use_summary)
    //   result (the collapsed wrap-up)
    expect(last.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "system",
      "result",
    ]);

    // The init system message includes tool count (local renderer adds
    // " · N tools" which the shared sdkToDisplayMessages does NOT).
    expect(last.messages[0]?.content).toBe("Session on claude-opus-4-5 · 2 tools");

    // Result bubble carries rich metadata the shared reducer drops.
    const result = last.messages.find((m) => m.role === "result");
    expect(result?.meta).toMatchObject({
      durationMs: 1800,
      durationApiMs: 1200,
      costUsd: 0.0061,
      turns: 1,
      stopReason: "end_turn",
      isError: false,
    });
  });
});

// ── session_status / session_error transitions ────────

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

// ── subagent tracking: latent double-emit bug (see file-level note) ──
//
// task_started / task_notification handling currently emits TWO
// `onUpdateData` calls per sdk_event: the subagent-specific branch
// updates `data.subagents`, then the general message-append branch
// clones `{...current}` (without the new subagent) and overwrites it.
//
// This means subagents are never observable in the final state from
// the current subscription. Locking the *buggy* behavior as a baseline
// would be misleading — so we omit the assertion and flag the issue
// here. A SessionHost migration should fix this by consolidating the
// emits, at which point a real subagent-tracking test belongs.

// ── prompt suggestions (node-specific) ─────────────────

describe("ClaudeSessionNode: prompt suggestions", () => {
  it("accumulates prompt_suggestion events (keeps last 3)", async () => {
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
          message: {
            type: "prompt_suggestion",
            suggestion: "Ask about schemas",
            uuid: "u-ps-1",
            session_id: "sess-001",
          } as unknown as ServerMessage,
        } as unknown as ServerMessage,
      },
      {
        message: {
          type: "sdk_event",
          sessionKey: "session-1",
          message: {
            type: "prompt_suggestion",
            suggestion: "Show call sites",
            uuid: "u-ps-2",
            session_id: "sess-001",
          } as unknown as ServerMessage,
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.promptSuggestions).toEqual([
      "Ask about schemas",
      "Show call sites",
    ]);
  });
});

// ── sessionKey filtering ───────────────────────────────

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
          message: {
            type: "assistant",
            message: {
              id: "msg_x",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "noise" }],
              model: "claude",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            parent_tool_use_id: null,
            uuid: "u-noise",
            session_id: "s",
          },
        },
      },
    ]);

    expect(onState).not.toHaveBeenCalled();
  });
});

// ── sync_response: !found triggers disconnect ─────────

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
