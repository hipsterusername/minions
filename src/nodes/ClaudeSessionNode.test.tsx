/**
 * Behavior baseline for ClaudeSessionNode's WebSocket subscription.
 *
 * ClaudeSessionNode is the fallback renderer for role="default" sessions
 * (see Canvas.tsx:638) and owns a ~160-line subscription effect that
 * mixes:
 *   • shared session-stream concerns (status, error, sync_response,
 *     streaming text deltas)
 *   • node-specific handling (init data capture)
 *
 * Phase 3: all sdk_event messages now carry `event: NormalizedEvent`
 * (not `message: SdkMessage`). The node's local `normalizedToSessionMessages`
 * handles the NormalizedEvent union directly. Legacy subtypes that had no
 * NormalizedEvent equivalent (task_started, task_notification,
 * prompt_suggestion) are no longer delivered over the wire.
 *
 * This file is the **test-first arrow guardrail** for any subsequent
 * migration: it locks observable behavior end-to-end so a future
 * refactor cannot silently change what the UI sees.
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
    lastDurationMs: null,
    subagents: [],
    promptSuggestions: [],
    initData: null,
    ...overrides,
  };
}

// ── End-to-end fixture replay ──────────────────────────

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

    // Cost / turns captured from the usage + done events.
    expect(last.totalCost).toBe(0.0061);
    expect(last.turns).toBe(1);

    // Status drops to "idle" on done.
    expect(last.status).toBe("idle");

    // Streaming buffer cleared on done.
    expect(last.streamingText).toBe("");

    // Prompt suggestions cleared on done.
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

    // Phase 3 fixture: init → text "I'll run ls." → tool_call Bash →
    // tool_progress Bash → text "Three top-level..." → usage → done.
    // The wrap-up assistant matches the result content → collapses.
    // Expected roles: system, assistant("I'll run ls."), tool, tool, result.
    expect(last.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "result",
    ]);

    // System bubble comes from the init event.
    expect(last.messages[0]?.content).toBe("Session on claude-opus-4-5");

    // Result bubble carries the collapsed wrap-up text.
    const result = last.messages.find((m) => m.role === "result");
    expect(result?.content).toBe(
      "Three top-level entries: src, README.md, package.json.",
    );
    // Phase 3: meta is only set for error results; success results don't carry it.
    expect(result?.meta?.isError).toBeUndefined();
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
          event: { kind: "text", text: "noise", role: "assistant" },
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
