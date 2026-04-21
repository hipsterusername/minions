/**
 * Behavior baseline for LeaderNode's WebSocket subscription.
 *
 * LeaderNode owns a ~340-line subscription effect that mixes:
 *   • shared session-stream concerns (messages, status, cost, turns,
 *     streaming deltas, sync_response rebuild) — about to migrate to
 *     `useSessionStream`
 *   • node-specific orchestration (taskName, waitUntil, worktree_*,
 *     approval_*)
 *
 * Test-first arrow guardrail for that migration: locks current
 * observable behavior end-to-end so the upcoming refactor cannot
 * silently change state the UI sees.
 */

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";

import { LeaderNodeRenderer, type LeaderData } from "./LeaderNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import type { ServerMessage } from "../use-socket.ts";
import {
  createReplaySocket,
  loadFixture,
  type FixtureEntry,
} from "../../tests/harness/ws-replay.ts";

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
      /* no-op */
    },
  };
  return <LeaderNodeRenderer {...props} />;
}

async function pump(
  replay: (entries: ReadonlyArray<FixtureEntry>) => Promise<void>,
  entries: ReadonlyArray<FixtureEntry>,
): Promise<void> {
  await act(async () => {
    await replay(entries);
  });
}

function makeInitialData(overrides: Partial<LeaderData> = {}): LeaderData {
  return {
    sessionKey: "leader-1",
    status: "running",
    messages: [],
    streamingText: "",
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

// ── End-to-end fixture replay ──────────────────────────

describe("LeaderNode: replays leader-plan-and-delegate fixture", () => {
  it("captures cost/turns, status, taskName, and builds message feed", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("leader-plan-and-delegate.jsonl");
    const states: LeaderData[] = [];

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

    // Cost / turns from result envelope.
    expect(last.totalCost).toBe(0.0288);
    expect(last.turns).toBe(1);

    // Status drops to "idle" on result.
    expect(last.status).toBe("idle");

    // taskName captured from session_task_name event.
    expect(last.taskName).toBe("Plan and delegate");

    // Message role sequence matches the canonical reducer snapshot
    // (see tests/harness/session-stream-snapshot.test.ts).
    // The last assistant ("Delegated task-a...") has different text
    // from the result ("Planned 2 tasks..."), so it is NOT collapsed.
    expect(last.messages.map((m) => m.role)).toEqual([
      "system",
      "thinking",
      "assistant",
      "tool",
      "tool",
      "tool",
      "tool",
      "assistant",
      "result",
    ]);

    // Streaming buffer cleared on result.
    expect(last.streamingText).toBe("");
  });
});

// ── session_status / session_error transitions ──────

describe("LeaderNode: status transitions", () => {
  it("session_status='stopped' sets status", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

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
          sessionKey: "leader-1",
          status: "stopped",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("stopped");
  });

  it("session_error flips status to 'error' and captures message", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

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
          sessionKey: "leader-1",
          error: "upstream 503",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("upstream 503");
  });

  it("session_status='running' clears waitUntil/waitReason", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          status: "idle",
          waitUntil: Date.now() + 60_000,
          waitReason: "waiting for build",
        })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "session_status",
          sessionKey: "leader-1",
          status: "running",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("running");
    expect(last?.waitUntil).toBeNull();
    expect(last?.waitReason).toBeNull();
  });
});

// ── wait_state ──────────────────────────────────────

describe("LeaderNode: wait_state events", () => {
  it("wait_state action='started' sets waitUntil/waitReason", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    const scheduledAt = 1_700_000_000_000;
    const durationMs = 60_000;

    await pump(replay, [
      {
        message: {
          type: "wait_state",
          sessionKey: "leader-1",
          action: "started",
          scheduledAt,
          durationMs,
          reason: "polling for deploy",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.waitUntil).toBe(scheduledAt + durationMs);
    expect(last?.waitReason).toBe("polling for deploy");
  });

  it("wait_state action='completed' clears wait state", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          waitUntil: 1_700_000_060_000,
          waitReason: "polling",
        })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "wait_state",
          sessionKey: "leader-1",
          action: "completed",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.waitUntil).toBeNull();
    expect(last?.waitReason).toBeNull();
  });
});

// ── worktree lifecycle ─────────────────────────────

describe("LeaderNode: worktree events", () => {
  it("worktree_created sets path/branch and status='active'", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

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
          type: "worktree_created",
          sessionKey: "leader-1",
          worktreePath: "/repo/.wt/feature-x",
          branch: "canvas/feature-x",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.worktreePath).toBe("/repo/.wt/feature-x");
    expect(last?.worktreeBranch).toBe("canvas/feature-x");
    expect(last?.worktreeStatus).toBe("active");
  });

  it("worktree_merged clears path/branch and sets status='merged'", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          worktreePath: "/repo/.wt/feature-x",
          worktreeBranch: "canvas/feature-x",
          worktreeStatus: "active",
          approvalPending: true,
        })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "worktree_merged",
          sessionKey: "leader-1",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.worktreePath).toBeNull();
    expect(last?.worktreeBranch).toBeNull();
    expect(last?.worktreeStatus).toBe("merged");
    expect(last?.mergeConfirmed).toBe(true);
  });
});

// ── approval lifecycle ─────────────────────────────

describe("LeaderNode: approval events", () => {
  it("approval_requested sets pending + summary + diff", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData()}
        onState={(d) => states.push(d)}
      />,
    );

    const diff = {
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      files: [{ file: "src/a.ts", insertions: 10, deletions: 3, status: "modified" }],
      commits: ["abc123"],
      branch: "canvas/feature-x",
    };

    await pump(replay, [
      {
        message: {
          type: "approval_requested",
          sessionKey: "leader-1",
          summary: "All tests pass",
          diff,
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.approvalPending).toBe(true);
    expect(last?.approvalSummary).toBe("All tests pass");
    expect(last?.approvalDiff).toEqual(diff);
  });

  it("approval_resolved clears pending + summary + diff", async () => {
    const { socket, replay } = createReplaySocket();
    const states: LeaderData[] = [];

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          approvalPending: true,
          approvalSummary: "tests pass",
          approvalDiff: {
            filesChanged: 1,
            insertions: 1,
            deletions: 0,
            files: [],
            commits: [],
            branch: "canvas/x",
          },
        })}
        onState={(d) => states.push(d)}
      />,
    );

    await pump(replay, [
      {
        message: {
          type: "approval_resolved",
          sessionKey: "leader-1",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.approvalPending).toBe(false);
    expect(last?.approvalSummary).toBeNull();
    expect(last?.approvalDiff).toBeNull();
  });
});

// ── sessionKey filter ─────────────────────────────

describe("LeaderNode: ignores mismatched sessionKey", () => {
  it("does not call onUpdateData for sdk_event on another session", async () => {
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
