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
 *      then a stream of `sdk_event`s (init, text_delta x2, stream_end,
 *      complete assistant text, usage, done).
 *   4. The final state must:
 *      - Reach `status: "idle"` (driven by the local subscription on
 *        done), not stay stuck on "creating" or "running".
 *      - Contain the user's prompt + system bubble + result bubble in
 *        order (done collapses the matching assistant).
 *      - Have an empty `streamingText` and `streamingBlockIndex: null`.
 *      - Capture cost / turns from the usage + done events.
 *
 * Phase 3: all sdk_event messages use `event: NormalizedEvent`.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, beforeAll, beforeEach } from "vitest";

import {
  LeaderNodeRenderer,
  claimLeaderAutoStart,
  resetLeaderAutoStartClaimsForTests,
  type LeaderData,
} from "./LeaderNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import type { ServerMessage } from "../use-socket.ts";
import { createReplaySocket } from "../../tests/harness/ws-replay.ts";
import type { WorkItemSnapshot } from "../../shared/work-item-contracts.ts";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  resetLeaderAutoStartClaimsForTests();
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

function canonicalItem(runKey: string | null, revision: number,
  runtimeState: "draft" | "starting" | "working" | "inactive",
  outcome: "none" | "completed" | "interrupted"): WorkItemSnapshot {
  return { id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
    lifecycle: { runtimeState, outcome, resolution: "open", changeMode: "live",
      integrationState: "live_clean", lifecycleRevision: revision }, waitKind: null,
    currentRunKey: runKey, iteration: runKey ? (runKey === "run-1" ? 1 : 2) : 0,
    workflowColumnId: "todo", workflowRank: "a", workflowRevision: 0,
    card: { description: "", subtasks: [], context: "", priority: "medium", model: "",
      permissionMode: "auto", worktreeIsolation: false, skillIds: [], skillValues: {},
      linkedContextNodeIds: [] }, lastTransitionAt: revision, createdAt: 1, updatedAt: revision };
}

/**
 * Synthetic NormalizedEvent sequence that mirrors what the SDK emits for a
 * one-turn assistant reply. Phase 3 format: all sdk_events carry
 * `event: NormalizedEvent`.
 *
 * Sequence:
 *   session_status "running"
 *   init → system bubble "Session on claude-opus-4-5"
 *   text_delta "" blockIndex=0   → seeds streaming buffer
 *   text_delta "Hello" blockIndex=0
 *   text_delta " world" blockIndex=0
 *   stream_end → clears buffer
 *   text "Hello world" role=assistant → assistant bubble, clears buffer
 *   usage costUSD:0.0021 → updates totalCost
 *   done result:"Hello world" turns:1 → collapses assistant, adds result, status→"idle"
 */
function buildInitMessages(sessionKey: string): ServerMessage[] {
  return [
    // Server: session is now running.
    { type: "session_status", sessionKey, status: "running" },
    // SDK: system init bubble.
    {
      type: "sdk_event",
      sessionKey,
      event: {
        kind: "init",
        sessionId: "leader-sess-init",
        model: "claude-opus-4-5",
        permissionMode: "default",
      },
    },
    // SDK: content_block_start index=0 — seeds the block.
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "text_delta", text: "", blockIndex: 0 },
    },
    // SDK: text_delta x2 — accumulates "Hello world".
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "text_delta", text: "Hello", blockIndex: 0 },
    },
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "text_delta", text: " world", blockIndex: 0 },
    },
    // SDK: message_stop — clears the buffer.
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "stream_end" },
    },
    // SDK: complete assistant — clears streaming buffer, adds final bubble.
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "text", text: "Hello world", role: "assistant" },
    },
    // SDK: usage — updates totalCost.
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "usage", input: 5, output: 4, costUSD: 0.0021 },
    },
    // SDK: done — flips status to "idle" via local subscription, captures
    // turns, collapses the matching assistant bubble.
    {
      type: "sdk_event",
      sessionKey,
      event: { kind: "done", reason: "completed", result: "Hello world", turns: 1 },
    },
  ] as ServerMessage[];
}

describe("LeaderNode: new-session initiation", () => {
  it("dedupes rapid auto-start claims for the same node and prompt", () => {
    expect(claimLeaderAutoStart("leader-node", "run it", 1000)).toBe(true);
    expect(claimLeaderAutoStart("leader-node", "run it", 1001)).toBe(false);
    expect(claimLeaderAutoStart("leader-node", "run it", 12_001)).toBe(true);
  });

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

    // Status reaches "idle" (driven by the local subscription on done).
    expect(last.status).toBe("idle");

    // Streaming buffer fully cleared.
    expect(last.streamingText).toBe("");
    expect(last.streamingBlockIndex ?? null).toBeNull();

    // The user's original prompt MUST still be in the feed (regression: a
    // late state replacement could overwrite it).
    expect(last.messages[0]?.role).toBe("user");
    expect(last.messages[0]?.content).toBe("Plan and execute.");

    // The reducer's collapse logic drops the duplicate "Hello world"
    // assistant when the done event arrives with matching content. Final
    // ordering: user → system → result.
    expect(last.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
      "result",
    ]);
    expect(last.messages.at(-1)?.content).toBe("Hello world");

    // Cost / turns captured from usage + done events.
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

  it("suppresses a manual Start after autoStart claimed the session (no double create_session)", async () => {
    // Reproduces the double-init / doubled-content race: autoStart fires on
    // mount and claims the session (syncedRef set), but the generated
    // sessionKey has NOT yet propagated back into node.data — here modelled by
    // an onUpdateData that swallows the update, so dataRef.current.sessionKey
    // stays null. A manual Start in that window must NOT open a second leader
    // host. Pre-fix (no syncedRef guard in handleCreate) this sent a second
    // create_session; each host then streamed its own copy of the reply.
    const { socket } = createReplaySocket();
    const captured: unknown[] = [];
    const mockSend = (msg: unknown) => {
      captured.push(msg);
    };

    // Stable node whose data never receives the sessionKey update.
    const node: CanvasNode = {
      id: "leader-race-1",
      type: "leader",
      position: { x: 0, y: 0 },
      size: { width: 480, height: 400 },
      data: disconnectedLeaderData({ autoStartPrompt: "Auto go" }),
    };

    function RaceProbe() {
      const props: NodeRenderProps = {
        node,
        isSelected: false,
        onUpdateData: () => {
          /* swallow: sessionKey never propagates to props (stale-dataRef window) */
        },
        socketSubscribe: socket.subscribe,
        socketSend: mockSend,
      };
      return <LeaderNodeRenderer {...props} />;
    }

    render(<RaceProbe />);

    const creates = () =>
      captured.filter((m) => (m as { type?: string }).type === "create_session");

    // autoStart fired exactly once on mount.
    expect(creates()).toHaveLength(1);

    // Manual Start while the sessionKey is still un-propagated.
    await act(async () => {
      fireEvent.change(screen.getByTestId("leader-prompt-input-inline"), {
        target: { value: "Manual go" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    // Still one create_session — the second was suppressed by the syncedRef guard.
    expect(creates()).toHaveLength(1);
  });

  it("creates, binds, and reuses a work item across distinct terminal iterations", async () => {
    const { socket, replay } = createReplaySocket();
    let latest: LeaderData = { ...disconnectedLeaderData(), harness: "codex" };
    function Probe() {
      const [data, setData] = useState(latest);
      latest = data;
      return <LeaderNodeRenderer node={{ id: "canvas-leader", type: "leader",
        position: { x: 0, y: 0 }, size: { width: 480, height: 400 }, data }}
        isSelected={false} projectId="project-1" projectPath="/repo"
        socketSubscribe={socket.subscribe} socketSend={socket.send}
        onUpdateData={(next) => setData(next as LeaderData)} />;
    }
    render(<Probe />);
    const latestCommand = (type: string) => socket.sent.filter((message) =>
      (message as { type?: string }).type === type).at(-1);
    fireEvent.change(screen.getByTestId("leader-prompt-input-inline"),
      { target: { value: "First iteration" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const create = latestCommand("create_work_item") as { requestId: string; workflowColumnId: string;
      cardPatch: { leaderNodeId: string; harness?: string } };
    expect(create).toMatchObject({ workflowColumnId: "in-progress",
      cardPatch: { leaderNodeId: "canvas-leader", harness: "codex" } });
    await act(() => replay([{ message: { type: "work_item_response", command: "create_work_item",
      requestId: create.requestId, success: true,
      result: { workItem: canonicalItem(null, 0, "draft", "none"), bindings: [], currentRun: null, runs: [], nextCursor: null } } }]));
    await waitFor(() => expect(latestCommand("attach_work_item_surface")).toBeDefined());
    const attach = latestCommand("attach_work_item_surface") as { requestId: string };
    await act(() => replay([{ message: { type: "work_item_response", command: "attach_work_item_surface",
      requestId: attach.requestId, success: true,
      result: { workItem: canonicalItem(null, 1, "draft", "none"), bindings: [], currentRun: null, runs: [], nextCursor: null } } }]));
    await waitFor(() => expect(latestCommand("start_work_item_run")).toBeDefined());
    const start = latestCommand("start_work_item_run") as { requestId: string };
    await act(() => replay([{ message: { type: "work_item_response", command: "start_work_item_run",
      requestId: start.requestId, success: true,
      result: { workItem: canonicalItem("run-1", 2, "starting", "none"), bindings: [], currentRun: null, runs: [], nextCursor: null } } }]));
    await waitFor(() => expect(latest.currentRunKey).toBe("run-1"));

    await act(() => replay([{ message: { type: "work_item_changed",
      workItem: canonicalItem("run-1", 3, "inactive", "completed"), revision: 3,
      cause: "run_sealed", timestamp: 3 } }]));
    fireEvent.change(screen.getByTestId("leader-prompt-input-inline"),
      { target: { value: "Second iteration" } });
    fireEvent.click(screen.getByRole("button", { name: "New iteration" }));
    await waitFor(() => expect(socket.sent.filter((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toHaveLength(2));
    const second = latestCommand("start_work_item_run") as { requestId: string; expectedCurrentRunKey: string };
    expect(second.expectedCurrentRunKey).toBe("run-1");
    await act(() => replay([{ message: { type: "work_item_response", command: "start_work_item_run",
      requestId: second.requestId, success: true,
      result: { workItem: canonicalItem("run-2", 4, "starting", "none"), bindings: [], currentRun: null, runs: [], nextCursor: null } } }]));
    await waitFor(() => expect([latest.workItemId, latest.currentRunKey]).toEqual(["work-1", "run-2"]));
  });

  it("rehydrates a persisted stale snapshot on mount so restarts use fresh fences", async () => {
    // Regression: node data (including workItemSnapshot) survives page reloads
    // and server restarts. Boot recovery bumps the lifecycle revision, so the
    // cached snapshot's fences are stale and every restart failed with
    // "stale work-item lifecycle". The node must re-read the item on mount.
    const { socket, replay } = createReplaySocket();
    let latest: LeaderData = { ...disconnectedLeaderData(), status: "stopped",
      sessionKey: "run-1", workItemId: "work-1",
      workItemSnapshot: canonicalItem("run-1", 3, "inactive", "completed") };
    function Probe() {
      const [data, setData] = useState(latest); latest = data;
      return <LeaderNodeRenderer node={{ id: "stale-leader", type: "leader",
        position: { x: 0, y: 0 }, size: { width: 480, height: 400 }, data }}
        isSelected={false} projectId="project-1" projectPath="/repo"
        socketSubscribe={socket.subscribe} socketSend={socket.send}
        onUpdateData={(next) => setData(next as LeaderData)} />;
    }
    render(<Probe />);
    await waitFor(() => expect(socket.sent.filter((message) =>
      (message as { type?: string }).type === "get_work_item").length).toBeGreaterThan(0));
    const gets = socket.sent.filter((message) =>
      (message as { type?: string }).type === "get_work_item") as Array<{ requestId: string }>;
    await act(() => replay(gets.map((get) => ({ message: {
      type: "work_item_response", command: "get_work_item", requestId: get.requestId,
      success: true, result: {
        workItem: canonicalItem("run-1", 5, "inactive", "interrupted"),
        bindings: [{ surface: "canvas", bindingId: "stale-leader", detachedAt: null }],
        currentRun: null, runs: [], nextCursor: null,
      } } }))));
    await waitFor(() => expect(latest.workItemSnapshot?.lifecycle.lifecycleRevision).toBe(5));
    fireEvent.change(screen.getByTestId("leader-prompt-input-inline"),
      { target: { value: "Pick it back up" } });
    fireEvent.click(screen.getByRole("button", { name: "New iteration" }));
    await waitFor(() => expect(socket.sent.some((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toBe(true));
    const start = socket.sent.filter((message) => (message as { type?: string }).type
      === "start_work_item_run").at(-1) as { expectedLifecycleRevision: number };
    expect(start.expectedLifecycleRevision).toBe(5);
  });

  it("retries a conflicted restart once with the server's fresh snapshot", async () => {
    const { socket, replay } = createReplaySocket();
    let latest: LeaderData = { ...disconnectedLeaderData(), status: "stopped",
      sessionKey: "run-1", workItemId: "work-1",
      workItemSnapshot: canonicalItem("run-1", 3, "inactive", "completed") };
    function Probe() {
      const [data, setData] = useState(latest); latest = data;
      return <LeaderNodeRenderer node={{ id: "conflict-leader", type: "leader",
        position: { x: 0, y: 0 }, size: { width: 480, height: 400 }, data }}
        isSelected={false} projectId="project-1" projectPath="/repo"
        socketSubscribe={socket.subscribe} socketSend={socket.send}
        onUpdateData={(next) => setData(next as LeaderData)} />;
    }
    render(<Probe />);
    fireEvent.change(screen.getByTestId("leader-prompt-input-inline"),
      { target: { value: "Restart me" } });
    fireEvent.click(screen.getByRole("button", { name: "New iteration" }));
    await waitFor(() => expect(socket.sent.some((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toBe(true));
    const first = socket.sent.filter((message) => (message as { type?: string }).type
      === "start_work_item_run").at(-1) as { requestId: string; expectedLifecycleRevision: number };
    expect(first.expectedLifecycleRevision).toBe(3);
    await act(() => replay([{ message: { type: "work_item_response",
      command: "start_work_item_run", requestId: first.requestId, success: false,
      error: "stale work-item lifecycle", code: "conflict", latest: null } }]));
    await waitFor(() => expect(socket.sent.filter((message) =>
      (message as { type?: string }).type === "get_work_item").length).toBeGreaterThan(0));
    const gets = socket.sent.filter((message) =>
      (message as { type?: string }).type === "get_work_item") as Array<{ requestId: string }>;
    await act(() => replay(gets.map((get) => ({ message: {
      type: "work_item_response", command: "get_work_item", requestId: get.requestId,
      success: true, result: {
        workItem: canonicalItem("run-1", 6, "inactive", "interrupted"),
        bindings: [{ surface: "canvas", bindingId: "conflict-leader", detachedAt: null }],
        currentRun: null, runs: [], nextCursor: null,
      } } }))));
    await waitFor(() => expect(socket.sent.filter((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toHaveLength(2));
    const retried = socket.sent.filter((message) => (message as { type?: string }).type
      === "start_work_item_run").at(-1) as { expectedLifecycleRevision: number };
    expect(retried.expectedLifecycleRevision).toBe(6);
    expect(latest.error ?? null).toBeNull();
  });

  it("restores the typed prompt when a competing surface already started the run", async () => {
    const { socket, replay } = createReplaySocket();
    let latest: LeaderData = { ...disconnectedLeaderData(), status: "stopped",
      sessionKey: "run-1", workItemId: "work-1",
      workItemSnapshot: canonicalItem("run-1", 3, "inactive", "completed") };
    function Probe() {
      const [data, setData] = useState(latest); latest = data;
      return <LeaderNodeRenderer node={{ id: "converge-leader", type: "leader",
        position: { x: 0, y: 0 }, size: { width: 480, height: 400 }, data }}
        isSelected={false} projectId="project-1" projectPath="/repo"
        socketSubscribe={socket.subscribe} socketSend={socket.send}
        onUpdateData={(next) => setData(next as LeaderData)} />;
    }
    render(<Probe />);
    const composer = screen.getByTestId("leader-prompt-input-inline");
    fireEvent.change(composer, { target: { value: "Keep this canvas prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "New iteration" }));
    await waitFor(() => expect(socket.sent.some((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toBe(true));
    const start = socket.sent.filter((message) => (message as { type?: string }).type
      === "start_work_item_run").at(-1) as { requestId: string };

    await act(() => replay([{ message: {
      type: "work_item_response", command: "start_work_item_run",
      requestId: start.requestId, success: false, error: "stale work-item lifecycle",
      code: "conflict",
      latest: { workItem: canonicalItem("run-2", 4, "working", "none"),
        bindings: [], currentRun: null, runs: [], nextCursor: null },
    } }]));

    await waitFor(() => expect(composer).toHaveValue("Keep this canvas prompt"));
    expect(socket.sent.filter((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toHaveLength(1);
    expect(latest.currentRunKey).toBe("run-2");
  });

  it("hydrates a legacy work item before restarting instead of using send_message", async () => {
    const { socket, replay } = createReplaySocket();
    let latest: LeaderData = { ...disconnectedLeaderData(), status: "stopped",
      sessionKey: "legacy-run", workItemId: "work-1" };
    function Probe() {
      const [data, setData] = useState(latest); latest = data;
      return <LeaderNodeRenderer node={{ id: "legacy-leader", type: "leader",
        position: { x: 0, y: 0 }, size: { width: 480, height: 400 }, data }}
        isSelected={false} projectId="project-1" projectPath="/repo"
        socketSubscribe={socket.subscribe} socketSend={socket.send}
        onUpdateData={(next) => setData(next as LeaderData)} />;
    }
    render(<Probe />);
    fireEvent.change(screen.getByTestId("leader-prompt-input-inline"),
      { target: { value: "Restart legacy work" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(socket.sent.filter((message) =>
      (message as { type?: string }).type === "get_work_item").length).toBeGreaterThan(0));
    const gets = socket.sent.filter((message) =>
      (message as { type?: string }).type === "get_work_item") as Array<{ requestId: string }>;
    const responses: Parameters<typeof replay>[0] = gets.map((get) => ({ message: {
      type: "work_item_response", command: "get_work_item",
      requestId: get.requestId, success: true,
      result: {
        workItem: canonicalItem("legacy-run", 3, "inactive", "interrupted"),
        bindings: [{ surface: "canvas", bindingId: "legacy-leader", detachedAt: null }],
        currentRun: null, runs: [], nextCursor: null,
      },
    } }));
    await act(() => replay(responses));
    await waitFor(() => expect(socket.sent.some((message) =>
      (message as { type?: string }).type === "start_work_item_run")).toBe(true));
    expect(socket.sent.some((message) =>
      (message as { type?: string }).type === "send_message")).toBe(false);
  });
});
