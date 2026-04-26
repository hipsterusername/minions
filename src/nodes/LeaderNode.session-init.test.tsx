/**
 * Regression: full new-leader session-initiation flow.
 *
 * Existing LeaderNode tests seed `sessionKey: "leader-1"`, `status: "running"`
 * and replay a fixture against it — they skip the disconnected → creating
 * → running transition entirely. This file pins the steps that an actual
 * new leader walks through:
 *
 *   1. Mount with `sessionKey: null`, `status: "disconnected"`.
 *   2. The user populates `sessionKey` + `status: "creating"` via the
 *      same `onUpdateData` path that `handleCreate` uses.
 *   3. Server replies `session_created`, then `session_status: "running"`,
 *      then a stream of `sdk_event`s (system init, message_start,
 *      content_block_start text, text_delta, message_delta, message_stop,
 *      complete assistant, result).
 *   4. The final state must:
 *      - Reach `status: "idle"` (driven by the local subscription on
 *        result), not stay stuck on "creating" or "running".
 *      - Contain the user's prompt + system bubble + assistant content +
 *        result bubble in order.
 *      - Have an empty `streamingText` and `streamingBlockIndex: null`.
 *      - Capture cost / turns from the result envelope.
 */

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, beforeAll } from "vitest";

import { LeaderNodeRenderer, type LeaderData } from "./LeaderNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import type { ServerMessage } from "../use-socket.ts";
import { createReplaySocket } from "../../tests/harness/ws-replay.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

function disconnectedLeaderData(overrides: Partial<LeaderData> = {}): LeaderData {
  return {
    sessionKey: null,
    status: "disconnected",
    messages: [],
    streamingText: "",
    streamingBlockIndex: null,
    totalCost: 0,
    turns: 0,
    error: null,
    model: "opus",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...DEFAULT_THINKING_CONFIG },
    taskPlan: [],
    worktreeIsolation: false,
    worktreePath: null,
    worktreeBranch: null,
    worktreeStatus: "none",
    skillIds: [],
    skillValues: {},
    skillPanelOpen: false,
    ...overrides,
  };
}

interface ProbeProps {
  socket: ReturnType<typeof createReplaySocket>["socket"];
  initial: LeaderData;
  onState?: (d: LeaderData) => void;
}

function Probe({ socket, initial, onState }: ProbeProps) {
  const [data, setData] = useState<LeaderData>(initial);
  const node: CanvasNode = {
    id: "leader-test",
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 480, height: 400 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => {
      const nextData = next as LeaderData;
      setData(nextData);
      onState?.(nextData);
    },
    socketSubscribe: socket.subscribe,
    socketSend: () => {
      /* no-op — we drive state mutations directly via setData below */
    },
  };
  return <LeaderNodeRenderer {...props} />;
}

/**
 * Synthetic SDK event sequence that mirrors what the SDK emits for a
 * one-turn assistant reply. Crafted so the streaming preview should
 * accumulate "Hello world" then clear when the final assistant lands,
 * and `result` should collapse the duplicate assistant bubble.
 */
function buildInitMessages(sessionKey: string): ServerMessage[] {
  const sid = "leader-sess-init";
  return [
    // Server: session is now running.
    { type: "session_status", sessionKey, status: "running" },
    // SDK: system init bubble.
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "system",
        subtype: "init",
        session_id: sid,
        claude_code_version: "2.0.0",
        cwd: "/repo",
        tools: [],
        model: "claude-opus-4-5",
        permissionMode: "default",
        apiKeySource: "env",
        mcp_servers: [],
        slash_commands: [],
        output_style: "text",
        skills: [],
        plugins: [],
        uuid: "u-init",
      },
    },
    // SDK: message_start (no-op for the reducer).
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: { type: "message_start", message: { id: "m1", role: "assistant" } },
        parent_tool_use_id: null,
        uuid: "u-ms",
        session_id: sid,
      },
    },
    // SDK: content_block_start, index=0, type=text — block 0 begins.
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        parent_tool_use_id: null,
        uuid: "u-cbs",
        session_id: sid,
      },
    },
    // SDK: text_delta x2 — accumulates "Hello world".
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        parent_tool_use_id: null,
        uuid: "u-d1",
        session_id: sid,
      },
    },
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
        parent_tool_use_id: null,
        uuid: "u-d2",
        session_id: sid,
      },
    },
    // SDK: content_block_stop, message_delta (pre-stop usage), message_stop.
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        parent_tool_use_id: null,
        uuid: "u-cbe",
        session_id: sid,
      },
    },
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 },
        },
        parent_tool_use_id: null,
        uuid: "u-md",
        session_id: sid,
      },
    },
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "stream_event",
        event: { type: "message_stop" },
        parent_tool_use_id: null,
        uuid: "u-mst",
        session_id: sid,
      },
    },
    // SDK: complete assistant — clears streaming buffer, adds final bubble.
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "assistant",
        message: {
          id: "msg_01",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          model: "claude-opus-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 4 },
        },
        parent_tool_use_id: null,
        uuid: "u-asst",
        session_id: sid,
      },
    },
    // SDK: result — flips status to "idle" via local subscription, captures
    // cost/turns, collapses the matching assistant bubble.
    {
      type: "sdk_event",
      sessionKey,
      message: {
        type: "result",
        subtype: "success",
        result: "Hello world",
        is_error: false,
        duration_ms: 800,
        duration_api_ms: 600,
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0.0021,
        usage: { input_tokens: 5, output_tokens: 4 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-res",
        session_id: sid,
      },
    },
  ] as ServerMessage[];
}

describe("LeaderNode: new-session initiation", () => {
  it("walks disconnected → creating → running → idle and renders the user prompt + reply", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    const initial = disconnectedLeaderData();
    let setDataExternal: ((d: LeaderData) => void) | null = null;

    function StatefulProbe() {
      const [data, setData] = useState<LeaderData>(initial);
      setDataExternal = setData;
      const node: CanvasNode = {
        id: "leader-test",
        type: "leader",
        position: { x: 0, y: 0 },
        size: { width: 480, height: 400 },
        data,
      };
      const props: NodeRenderProps = {
        node,
        isSelected: false,
        onUpdateData: (next) => {
          const nextData = next as LeaderData;
          setData(nextData);
          states.push(nextData);
        },
        socketSubscribe: socket.subscribe,
        socketSend: () => {
          /* no-op */
        },
      };
      return <LeaderNodeRenderer {...props} />;
    }

    render(<StatefulProbe />);

    // ── Step 1: simulate handleCreate's local update — sessionKey set,
    // status:"creating", user prompt appended. This is what actually
    // happens when the user clicks send on a new leader.
    const sessionKey = "leader-init-1";
    await act(async () => {
      setDataExternal?.({
        ...initial,
        sessionKey,
        status: "creating",
        messages: [
          {
            id: "lm-user-1",
            role: "user",
            content: "Plan and execute.",
            timestamp: 0,
          },
        ],
      });
    });

    // ── Step 2: replay the server's response stream.
    await act(async () => {
      await replay(buildInitMessages(sessionKey).map((message) => ({ message })));
    });

    const last = states.at(-1);
    expect(last).toBeDefined();
    if (!last) return;

    // Status reaches "idle" (driven by the local subscription on result).
    expect(last.status).toBe("idle");

    // Streaming buffer fully cleared.
    expect(last.streamingText).toBe("");
    expect(last.streamingBlockIndex ?? null).toBeNull();

    // The user's original prompt MUST still be in the feed (regression: a
    // late state replacement could overwrite it).
    expect(last.messages[0]?.role).toBe("user");
    expect(last.messages[0]?.content).toBe("Plan and execute.");

    // The reducer's collapse logic drops the duplicate "Hello world"
    // assistant when the result arrives with matching content. Final
    // ordering: user → system → result.
    expect(last.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
      "result",
    ]);
    expect(last.messages.at(-1)?.content).toBe("Hello world");

    // Cost / turns captured from result.
    expect(last.totalCost).toBe(0.0021);
    expect(last.turns).toBe(1);
  });

  it("does not lose the user prompt across the creating → running transition", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    const initial = disconnectedLeaderData();
    let setDataExternal: ((d: LeaderData) => void) | null = null;

    function StatefulProbe() {
      const [data, setData] = useState<LeaderData>(initial);
      setDataExternal = setData;
      const node: CanvasNode = {
        id: "leader-test-2",
        type: "leader",
        position: { x: 0, y: 0 },
        size: { width: 480, height: 400 },
        data,
      };
      const props: NodeRenderProps = {
        node,
        isSelected: false,
        onUpdateData: (next) => {
          const nextData = next as LeaderData;
          setData(nextData);
          states.push(nextData);
        },
        socketSubscribe: socket.subscribe,
        socketSend: () => {
          /* no-op */
        },
      };
      return <LeaderNodeRenderer {...props} />;
    }

    render(<StatefulProbe />);

    const sessionKey = "leader-init-2";
    await act(async () => {
      setDataExternal?.({
        ...initial,
        sessionKey,
        status: "creating",
        messages: [
          {
            id: "lm-user-2",
            role: "user",
            content: "Investigate the regression.",
            timestamp: 0,
          },
        ],
      });
    });

    // Send only the session_status="running" — no sdk_events yet. This
    // simulates the brief window before the SDK starts streaming.
    await act(async () => {
      await replay([
        {
          message: { type: "session_status", sessionKey, status: "running" },
        },
      ]);
    });

    const last = states.at(-1);
    expect(last).toBeDefined();
    if (!last) return;

    expect(last.status).toBe("running");
    // The user prompt must survive the status transition.
    expect(last.messages.map((m) => m.role)).toEqual(["user"]);
    expect(last.messages[0]?.content).toBe("Investigate the regression.");
  });
});
