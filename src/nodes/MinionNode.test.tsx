import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";

import { MinionNodeRenderer, type MinionData } from "./MinionNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { MINION_THINKING_CONFIG } from "../types.ts";
import type { ServerMessage } from "../use-socket.ts";
import {
  createReplaySocket,
  loadFixture,
  type FixtureEntry,
} from "../../tests/harness/ws-replay.ts";

// jsdom doesn't ship ResizeObserver. The renderer uses one for autoresize;
// give it a no-op so mounting doesn't blow up.
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
  initial: MinionData;
  onState?: (d: MinionData) => void;
}

/**
 * Stateful wrapper that holds MinionData and re-renders the node on
 * each `onUpdateData`. Mirrors how Canvas hosts a node in production.
 */
function Probe({ socket, initial, onState }: ProbeProps) {
  const [data, setData] = useState<MinionData>(initial);
  const node: CanvasNode = {
    id: "minion-test",
    type: "minion",
    position: { x: 0, y: 0 },
    size: { width: 340, height: 200 },
    data,
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: (next) => {
      const nextData = next as MinionData;
      setData(nextData);
      onState?.(nextData);
    },
    socketSubscribe: socket.subscribe,
    socketSend: () => {
      /* no-op — auto-advance attempts a send when there's a next task */
    },
  };
  return <MinionNodeRenderer {...props} />;
}

async function pump(
  replay: (entries: ReadonlyArray<FixtureEntry>) => Promise<void>,
  entries: ReadonlyArray<FixtureEntry>,
): Promise<void> {
  await act(async () => {
    await replay(entries);
  });
}

function makeInitialData(overrides: Partial<MinionData> = {}): MinionData {
  return {
    sessionKey: "minion-task-a",
    status: "running",
    leaderId: null,
    taskQueue: [
      {
        taskId: "task-a",
        title: "Patch source file",
        description: "Patch the header in src/index.ts",
        priority: "high",
        status: "in_progress",
        activeStep: null,
        progress: [],
        result: null,
      },
    ],
    activeTaskIndex: 0,
    messages: [],
    streamingText: "",
    totalCost: 0,
    turns: 0,
    error: null,
    model: "sonnet",
    permissionMode: "bypassPermissions",
    thinkingConfig: { ...MINION_THINKING_CONFIG },
    ...overrides,
  };
}

// ── End-to-end fixture replay ──────────────────────────

describe("MinionNode: execution log scroll capture", () => {
  it("captures wheel events in the expanded log", () => {
    const { socket } = createReplaySocket();
    const { container, getByRole } = render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: "A long-running task log entry",
              timestamp: Date.now(),
            },
          ],
        })}
      />,
    );

    fireEvent.click(getByRole("button", { name: /log \(1\)/i }));

    const log = container.querySelector("[data-scroll-capture]");
    expect(log).toBeTruthy();
    if (!log) return;

    const bubbled = vi.fn();
    container.addEventListener("wheel", bubbled);
    log.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true }));

    expect(bubbled).not.toHaveBeenCalled();
  });
});

describe("MinionNode: replays minion-completes-task fixture", () => {
  it("captures cost/turns, builds the message feed, and marks the active task completed", async () => {
    const { socket, replay } = createReplaySocket();
    const entries = loadFixture("minion-completes-task.jsonl");
    const states: MinionData[] = [];

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
    expect(last.totalCost).toBe(0.0114);
    expect(last.turns).toBe(3);

    // No next pending task → status drops to "idle".
    expect(last.status).toBe("idle");

    // Active task is marked completed with the result text from the SDK.
    expect(last.taskQueue[0]?.status).toBe("completed");
    expect(last.taskQueue[0]?.result).toBe("Patched 1 file");
    expect(last.taskQueue[0]?.activeStep).toBeNull();

    // Message roles match the canonical reducer snapshot.
    // (locked by tests/harness/session-stream-snapshot.test.ts)
    expect(last.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "tool",
      "result",
    ]);

    // Streaming buffer is cleared on result.
    expect(last.streamingText).toBe("");
  });
});

// ── session_status / session_error orchestration ──────

describe("MinionNode: status transitions block in-progress tasks", () => {
  it("session_status='stopped' blocks the active task and clears activeTaskIndex", async () => {
    const { socket, replay } = createReplaySocket();
    const states: MinionData[] = [];

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
          sessionKey: "minion-task-a",
          status: "stopped",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("stopped");
    expect(last?.activeTaskIndex).toBe(-1);
    expect(last?.taskQueue[0]?.status).toBe("blocked");
    expect(last?.taskQueue[0]?.result).toContain("Session stopped");
  });

  it("session_error fails the active task and sets error text", async () => {
    const { socket, replay } = createReplaySocket();
    const states: MinionData[] = [];

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
          sessionKey: "minion-task-a",
          error: "model returned 500",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("model returned 500");
    expect(last?.activeTaskIndex).toBe(-1);
    expect(last?.taskQueue[0]?.status).toBe("failed");
    expect(last?.taskQueue[0]?.result).toBe("model returned 500");
  });
});

// ── minion_status MCP echoes ──────────────────────────

describe("MinionNode: minion_status MCP echoes update the active task", () => {
  it("trigger='step' appends to progress and sets activeStep", async () => {
    const { socket, replay } = createReplaySocket();
    const states: MinionData[] = [];

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
          // Server-emitted echo of mcp__minion__report_step
          type: "minion_status",
          minionSessionKey: "minion-task-a",
          trigger: "step",
          message: "Reading source file",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.taskQueue[0]?.activeStep).toBe("Reading source file");
    expect(last?.taskQueue[0]?.progress).toEqual(["Reading source file"]);
    expect(last?.messages.at(-1)?.role).toBe("system");
    expect(last?.messages.at(-1)?.content).toBe("Step: Reading source file");
  });

  it("trigger='done' marks the task completed", async () => {
    const { socket, replay } = createReplaySocket();
    const states: MinionData[] = [];

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
          type: "minion_status",
          minionSessionKey: "minion-task-a",
          trigger: "done",
          message: "Patched 1 file",
        } as unknown as ServerMessage,
      },
    ]);

    const last = states.at(-1);
    expect(last?.taskQueue[0]?.status).toBe("completed");
    expect(last?.taskQueue[0]?.result).toBe("Patched 1 file");
    expect(last?.taskQueue[0]?.activeStep).toBeNull();
    expect(last?.messages.at(-1)?.role).toBe("system");
    expect(last?.messages.at(-1)?.content).toBe("Done: Patched 1 file");
  });
});

// ── sessionKey filtering ──────────────────────────────

describe("MinionNode: ignores messages for other sessionKeys", () => {
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
