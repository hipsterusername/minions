import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SocketSubscribe } from "../use-socket.ts";
import { createGraphFixture } from "./fixtures.ts";
import { LeaderTaskGraphBridge } from "./LeaderTaskGraphBridge.tsx";
import { useLeaderTaskGraphController } from "./use-leader-task-graph-controller.ts";

function setup() {
  const listeners = new Set<(message: unknown) => void>();
  const subscribe = Object.assign(((_topic: string, fn: (message: unknown) => void) => {
    listeners.add(fn); return () => { listeners.delete(fn); };
  }) as SocketSubscribe, { supportsTopics: true as const });
  const send = vi.fn();
  const emit = (message: unknown) => act(() => { for (const fn of listeners) fn(message); });
  function Harness() {
    const controller = useLeaderTaskGraphController({ workItemId: "work-1", socketSend: send, socketSubscribe: subscribe });
    return <><button onClick={controller.openInspector}>Inspect</button><LeaderTaskGraphBridge controller={controller} /></>;
  }
  render(<Harness />);
  const snapshot = createGraphFixture(10);
  const load = (value = snapshot) => emit({ topic: "work-item:work-1", type: "task_graph_snapshot",
    workItemId: "work-1", runId: value.graphRunId, revision: value.revision, snapshot: value,
    cause: "command_snapshot", timestamp: 1 });
  load();
  fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
  fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
  const retry = () => fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const commands = () => send.mock.calls.map(([value]) => value).filter(value => value.type === "retry_task_node");
  return { emit, load, snapshot, retry, commands };
}

describe("task retry receipts", () => {
  it("retains accepted retries through timeout, unchanged refresh and reconnect until admission", () => {
    vi.useFakeTimers();
    try {
      const { emit, load, snapshot, retry, commands } = setup();
      retry();
      emit({ type: "task_graph_response", command: "retry_task_node", requestId: commands()[0].requestId,
        success: true, result: {} });
      act(() => vi.advanceTimersByTime(15000));
      load({ ...snapshot, revision: 43 });
      emit({ type: "socket_reconnected" });
      load({ ...snapshot, revision: 43 });
      expect(screen.getByText("Retry accepted · waiting to start")).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
      retry();
      expect(commands()).toHaveLength(1);
      load({ ...snapshot, revision: 44, nodes: snapshot.nodes.map(node => node.id === "node-7"
        ? { ...node, currentAttempt: { ...node.currentAttempt!, id: "attempt-7-3", number: 3, state: "queued" as const } } : node) });
      expect(screen.getByText("Attempt 3 queued")).toBeVisible();
    } finally { vi.useRealTimers(); }
  });
  it("waits through latency and ack for the actual attempt, preserving selected details and focus", () => {
    const { emit, load, snapshot, retry, commands } = setup();
    const focus = screen.getByRole("button", { name: "Close task details" });
    focus.focus();
    retry(); retry();
    expect(commands()).toHaveLength(1);
    expect(screen.getByText("Retry requested…")).toBeVisible();
    emit({ type: "task_graph_response", command: "retry_task_node", requestId: commands()[0].requestId,
      success: true, result: {} });
    expect(screen.getByText("Retry accepted · waiting to start")).toBeVisible();
    const nodes = snapshot.nodes.map(node => node.id === "node-7" ? { ...node,
      currentAttempt: { ...node.currentAttempt!, id: "attempt-7-3", number: 3, state: "queued" as const } } : node).reverse();
    load({ ...snapshot, revision: 43, nodes });
    expect(screen.getByText("Attempt 3 queued")).toBeVisible();
    expect(screen.queryByText("Retry requested…")).toBeNull();
    expect(screen.getByRole("heading", { name: "Task 7" })).toBeVisible();
    expect(focus).toHaveFocus();
  });
  it("ignores unrelated failure and recovers stale rejection using a refreshed revision", () => {
    const { emit, load, snapshot, retry, commands } = setup();
    retry();
    const failure = { type: "task_graph_response", command: "retry_task_node", success: false,
      code: "conflict", error: "Revision changed", latest: null };
    emit({ ...failure, requestId: "unrelated" });
    expect(screen.getByText("Retry requested…")).toBeVisible();
    emit({ ...failure, requestId: commands()[0].requestId });
    expect(screen.getByRole("alert")).toHaveTextContent("Task state changed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh task state" })).toBeEnabled();
    load({ ...snapshot, revision: 43 });
    retry();
    expect(commands()).toHaveLength(2);
    expect(commands()[1].expectedRunRevision).toBe(43);
  });
  it("keeps reconnect uncertainty actionable without resending or inventing an attempt", () => {
    const { emit, load, snapshot, retry, commands } = setup();
    retry();
    emit({ type: "socket_reconnected" });
    expect(screen.getByRole("alert")).toHaveTextContent("Retry not confirmed after reconnect");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    load({ ...snapshot, revision: 43 });
    expect(commands()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    retry();
    expect(commands()).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Retry not confirmed");
  });
  it("offers snapshot recovery when a retry acknowledgement never arrives", () => {
    vi.useFakeTimers();
    try {
      const { load, snapshot, retry, commands } = setup();
      retry();
      act(() => vi.advanceTimersByTime(15000));
      expect(screen.getByRole("alert")).toHaveTextContent("Retry not confirmed");
      expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Refresh task state" }));
      load({ ...snapshot });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
      retry();
      expect(commands()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

});
