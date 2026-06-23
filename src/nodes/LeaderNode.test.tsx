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

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";

import {
  LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD,
  LeaderNodeRenderer,
  type LeaderData,
} from "./LeaderNode.tsx";
import type { CanvasNode, ContextItem, NodeRenderProps } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import { canvasScale } from "../canvas-scale.ts";
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

afterEach(() => {
  canvasScale.current = 1;
});

interface ProbeProps {
  socket: ReturnType<typeof createReplaySocket>["socket"];
  initial: LeaderData;
  onState?: (d: LeaderData) => void;
  onAddContentNode?: ((content: string) => void) | undefined;
}

function Probe({ socket, initial, onState, onAddContentNode }: ProbeProps) {
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
    onAddContentNode,
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

describe("LeaderNode: message actions", () => {
  it("opens a shared enlarged prompt when the inline prompt is focused at zoomed-out scale", async () => {
    const { socket } = createReplaySocket();
    canvasScale.current = LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD - 0.05;
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "leader-prompt-context" ? 720 : 0;
      },
    });

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          sessionKey: null,
          status: "disconnected",
          taskName: "Import workflow",
          messages: [
            {
              id: "prior-user",
              role: "user",
              content: "Build the import workflow",
              timestamp: 0,
            },
            {
              id: "prior-assistant",
              role: "assistant",
              content: "I found the parser entry point.",
              timestamp: 1,
            },
          ],
        })}
      />,
    );

    const inlinePrompt = screen.getByTestId("leader-prompt-input-inline");
    fireEvent.focus(inlinePrompt);

    const overlay = screen.getByTestId("leader-prompt-overlay");
    expect(overlay).toBeInTheDocument();
    expect(within(overlay).getByText("Import workflow")).toBeInTheDocument();
    expect(within(overlay).getByAltText("Idle")).toBeInTheDocument();
    expect(within(overlay).queryByText("Leader prompt")).not.toBeInTheDocument();
    const context = within(overlay).getByTestId("leader-prompt-context");
    expect(context).toHaveTextContent("Build the import workflow");
    expect(context).toHaveTextContent("I found the parser entry point.");
    expect(context.scrollTop).toBe(720);

    const overlayPrompt = screen.getByTestId("leader-prompt-input-overlay");
    await waitFor(() => expect(document.activeElement).toBe(overlayPrompt));

    fireEvent.change(overlayPrompt, {
      target: { value: "Plan from the large prompt" },
    });

    expect(inlinePrompt).toHaveValue("Plan from the large prompt");

    fireEvent.keyDown(overlayPrompt, { key: "Escape" });
    expect(screen.queryByTestId("leader-prompt-overlay")).not.toBeInTheDocument();
    if (scrollHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollHeight;
    }
  });

  it("keeps the inline prompt in place at readable zoom", () => {
    const { socket } = createReplaySocket();
    canvasScale.current = LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD + 0.1;

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          sessionKey: null,
          status: "disconnected",
        })}
      />,
    );

    fireEvent.focus(screen.getByTestId("leader-prompt-input-inline"));

    expect(screen.queryByTestId("leader-prompt-overlay")).not.toBeInTheDocument();
  });

  it("keeps assistant bubble actions sticky within the message bubble", () => {
    const { socket } = createReplaySocket();
    const longContent = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n");

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          messages: [{
            id: "assistant-long",
            role: "assistant",
            content: longContent,
            timestamp: 0,
          }],
        })}
        onAddContentNode={vi.fn()}
      />,
    );

    const actions = screen.getByTestId("leader-message-actions");
    expect(actions).toHaveStyle({ position: "sticky", top: "8px", height: "0px" }); // BANNED_ASSERTION_OK: sticky position proves action bar stays visible during scroll
    expect(within(actions).getByTitle("Add as node")).toHaveStyle({ position: "static" }); // BANNED_ASSERTION_OK: static position proves buttons don't re-offset inside the sticky container
    expect(within(actions).getByTitle("Copy to clipboard")).toHaveStyle({ position: "static" }); // BANNED_ASSERTION_OK: static position proves buttons don't re-offset inside the sticky container
  });

  it("selects message chunks and copies only selected source text", () => {
    const { socket } = createReplaySocket();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          messages: [{
            id: "assistant-chunked",
            role: "assistant",
            content: [
              "Intro paragraph",
              "",
              "- first item",
              "- second item",
              "",
              "```ts",
              "const answer = 42;",
              "```",
            ].join("\n"),
            timestamp: 0,
          }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("selectable-message"));

    const chunks = screen.getAllByTestId("message-chunk");
    expect(chunks).toHaveLength(3);

    fireEvent.click(chunks[1]!);
    fireEvent.click(screen.getByTitle("Copy selected chunks"));

    expect(writeText).toHaveBeenCalledWith("- first item\n- second item");
  });

  it("adds selected chunks as a markdown node", () => {
    const { socket } = createReplaySocket();
    const onAddContentNode = vi.fn();

    render(
      <Probe
        socket={socket}
        onAddContentNode={onAddContentNode}
        initial={makeInitialData({
          messages: [{
            id: "assistant-add-chunk",
            role: "assistant",
            content: "Keep this\n\nSkip this",
            timestamp: 0,
          }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("selectable-message"));
    fireEvent.click(screen.getAllByTestId("message-chunk")[0]!);
    fireEvent.click(screen.getByTitle("Add selected chunks as node"));

    expect(onAddContentNode).toHaveBeenCalledWith("Keep this");
  });

  it("keeps chunk selection tied to assistant messages around grouped tools", () => {
    const { socket } = createReplaySocket();

    render(
      <Probe
        socket={socket}
        initial={makeInitialData({
          messages: [
            {
              id: "assistant-before-tools",
              role: "assistant",
              content: "Before tools",
              timestamp: 0,
            },
            {
              id: "tool-read",
              role: "tool",
              content: "Read result",
              timestamp: 1,
              toolName: "Read",
            },
            {
              id: "tool-grep",
              role: "tool",
              content: "Grep result",
              timestamp: 2,
              toolName: "Grep",
            },
            {
              id: "assistant-after-tools",
              role: "assistant",
              content: "After tools\n\n- keep this",
              timestamp: 3,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Read, Grep")).toBeInTheDocument();
    const bubbles = screen.getAllByTestId("selectable-message");
    expect(bubbles).toHaveLength(2);

    fireEvent.click(bubbles[1]!);

    expect(bubbles[0]).not.toHaveAttribute("data-selected");
    expect(bubbles[1]).toHaveAttribute("data-selected", "true");
    expect(within(bubbles[1]!).getAllByTestId("message-chunk")).toHaveLength(2);
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
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

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
          fullError: "upstream 503\nfull stderr detail",
        },
      },
    ]);

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("upstream 503");
    await act(async () => {
      screen.getByTitle("Copy error to clipboard").click();
    });
    expect(writeText).toHaveBeenCalledWith("upstream 503\nfull stderr detail");
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

// ── Connected-context dedup ────────────────────────────────────────────────
// Verifies that delta-based context injection works end-to-end:
//   1. Full block injected at session creation (hashes seeded).
//   2. Unchanged context → no <connected-context> in send_message.
//   3. Changed context → only changed group included in the delta block.

describe("LeaderNode: connected-context dedup", () => {
  it("seeds hashes at creation and omits unchanged context on subsequent sends", async () => {
    const { socket } = createReplaySocket();
    const captured: unknown[] = [];
    const mockSend = (msg: unknown) => { captured.push(msg); };

    // Use a mutable reference so we can change what getContextForNode returns
    // without changing the function reference (keeping handleSend stable).
    let contextSnapshot: ContextItem[] = [
      { nodeId: "ctx-1", nodeType: "markdown", label: "markdown", content: "Initial context" },
    ];
    const getContextForNode = () => contextSnapshot;

    function ContextProbe() {
      const [data, setData] = useState<LeaderData>(
        makeInitialData({ sessionKey: null, status: "disconnected" }),
      );
      const node: CanvasNode = {
        id: "leader-ctx-1",
        type: "leader",
        position: { x: 0, y: 0 },
        size: { width: 480, height: 400 },
        data,
      };
      const props: NodeRenderProps = {
        node,
        isSelected: false,
        onUpdateData: (next) => setData(next as LeaderData),
        socketSubscribe: socket.subscribe,
        socketSend: mockSend,
        getContextForNode,
      };
      return <LeaderNodeRenderer {...props} />;
    }

    render(<ContextProbe />);

    // ── Step 1: create session with context ──────────────────────────────
    await act(async () => {
      fireEvent.change(screen.getByTestId("leader-prompt-input-inline"), {
        target: { value: "Initial task" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    const nonCanvasCommands = () =>
      captured.filter((msg) => (msg as { type?: string }).type !== "canvas_context");
    const canvasCommands = () =>
      captured.filter((msg) => (msg as { type?: string }).type === "canvas_context");

    expect(nonCanvasCommands()).toHaveLength(1);
    expect(canvasCommands()).toHaveLength(1);
    const createMsg = nonCanvasCommands()[0] as { type: string; prompt: string };
    expect(createMsg.type).toBe("create_session");
    // Full context block injected at session creation
    expect(createMsg.prompt).toContain("<connected-context>");
    expect(createMsg.prompt).toContain("Initial context");
    expect(createMsg.prompt).toContain("Initial task");

    // ── Step 2: send with UNCHANGED context ─────────────────────────────
    // Input was cleared by handleCreate; type a new message.
    await act(async () => {
      fireEvent.change(screen.getByTestId("leader-prompt-input-inline"), {
        target: { value: "Follow-up question" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(nonCanvasCommands()).toHaveLength(2);
    expect(canvasCommands()).toHaveLength(1);
    const sendMsg1 = nonCanvasCommands()[1] as { type: string; prompt: string };
    expect(sendMsg1.type).toBe("send_message");
    // Unchanged context → no context block at all
    expect(sendMsg1.prompt).toBe("Follow-up question");
    expect(sendMsg1.prompt).not.toContain("<connected-context>");

    // ── Step 3: mutate context, send → delta block present ──────────────
    contextSnapshot = [
      { nodeId: "ctx-1", nodeType: "markdown", label: "markdown", content: "UPDATED context" },
    ];

    await act(async () => {
      fireEvent.change(screen.getByTestId("leader-prompt-input-inline"), {
        target: { value: "After update" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(nonCanvasCommands()).toHaveLength(3);
    expect(canvasCommands()).toHaveLength(2);
    const sendMsg2 = nonCanvasCommands()[2] as { type: string; prompt: string };
    expect(sendMsg2.type).toBe("send_message");
    // Delta block present with ONLY the changed item
    expect(sendMsg2.prompt).toContain("<connected-context>");
    expect(sendMsg2.prompt).toContain("UPDATED context");
    expect(sendMsg2.prompt).not.toContain("Initial context");
    expect(sendMsg2.prompt).toContain("After update");
  });

  it("includes only the changed group when one of several context nodes changes", async () => {
    const { socket } = createReplaySocket();
    const captured: unknown[] = [];
    const mockSend = (msg: unknown) => { captured.push(msg); };

    let contextSnapshot: ContextItem[] = [
      { nodeId: "node-a", nodeType: "markdown", label: "markdown", content: "stable content" },
      { nodeId: "node-b", nodeType: "markdown", label: "Notes", content: "original notes" },
    ];
    const getContextForNode = () => contextSnapshot;

    function MultiContextProbe() {
      const [data, setData] = useState<LeaderData>(
        makeInitialData({ sessionKey: null, status: "disconnected" }),
      );
      const node: CanvasNode = {
        id: "leader-multi-ctx",
        type: "leader",
        position: { x: 0, y: 0 },
        size: { width: 480, height: 400 },
        data,
      };
      const props: NodeRenderProps = {
        node,
        isSelected: false,
        onUpdateData: (next) => setData(next as LeaderData),
        socketSubscribe: socket.subscribe,
        socketSend: mockSend,
        getContextForNode,
      };
      return <LeaderNodeRenderer {...props} />;
    }

    render(<MultiContextProbe />);

    // Create session to seed hashes for both nodes
    await act(async () => {
      fireEvent.change(screen.getByTestId("leader-prompt-input-inline"), {
        target: { value: "setup" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    const nonCanvasCommands = () =>
      captured.filter((msg) => (msg as { type?: string }).type !== "canvas_context");
    expect((nonCanvasCommands()[0] as { type: string }).type).toBe("create_session");

    // Only change node-b; node-a remains the same
    contextSnapshot = [
      { nodeId: "node-a", nodeType: "markdown", label: "markdown", content: "stable content" },
      { nodeId: "node-b", nodeType: "markdown", label: "Notes", content: "updated notes" },
    ];

    await act(async () => {
      fireEvent.change(screen.getByTestId("leader-prompt-input-inline"), {
        target: { value: "ask about notes" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(nonCanvasCommands()).toHaveLength(2);
    const sendMsg = nonCanvasCommands()[1] as { type: string; prompt: string };
    expect(sendMsg.type).toBe("send_message");
    // Delta block includes the changed node-b
    expect(sendMsg.prompt).toContain("updated notes");
    // Stable node-a must NOT appear in the delta block
    expect(sendMsg.prompt).not.toContain("stable content");
    expect(sendMsg.prompt).toContain("ask about notes");
  });
});
