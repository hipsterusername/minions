import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SocketSubscribe } from "../use-socket.ts";
import { taskGraphPlanSnapshotViewSchema } from "../../shared/task-graph-planning-contracts.ts";
import { createGraphFixture } from "./fixtures.ts";
import { foldTaskGraphPlan, graphActionToCommand, useTaskGraphView } from "./use-task-graph-view.ts";

function createSocket() {
  const listeners = new Set<(message: unknown) => void>();
  const subscribe = Object.assign(
    ((_topic: string, listener: (message: unknown) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }) as unknown as SocketSubscribe,
    { supportsTopics: true as const },
  );
  return {
    subscribe,
    emit(message: unknown) { for (const listener of listeners) listener(message); },
  };
}

function envelope(type: "task_graph_snapshot" | "task_graph_changed", revision: number) {
  const snapshot = { ...createGraphFixture(10), revision };
  if (type === "task_graph_changed") return {
    topic:"work-item:work-1",type,workItemId:"work-1",runId:snapshot.graphRunId,revision,
    cause:"attempt_progress",timestamp:1,changes:{ status:snapshot.status,updatedAt:snapshot.updatedAt,
      nodes:snapshot.nodes.slice(0,1),edges:[],evidence:[],timeline:[],capacity:snapshot.capacity,
      budget:snapshot.budget,criticalPath:snapshot.criticalPath },
  };
  return {
    topic: "work-item:work-1",
    type,
    cause:"command_snapshot",
    workItemId: "work-1",
    runId:snapshot.graphRunId,revision,snapshot,
    timestamp: 1,
  };
}

describe("useTaskGraphView", () => {
  it("folds adjacent revisions, ignores stale changes, and refetches gaps", () => {
    const socket = createSocket();
    const send = vi.fn();
    const { result } = renderHook(() => useTaskGraphView({
      workItemId: "work-1", send, subscribe: socket.subscribe,
    }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "get_task_graph_snapshot", workItemId: "work-1",
    }));
    act(() => socket.emit(envelope("task_graph_snapshot", 42)));
    expect(result.current.snapshot?.revision).toBe(42);
    expect(result.current.controlsEnabled).toBe(true);

    act(() => socket.emit(envelope("task_graph_changed", 43)));
    expect(result.current.snapshot?.revision).toBe(43);
    act(() => socket.emit(envelope("task_graph_changed", 42)));
    expect(result.current.snapshot?.revision).toBe(43);

    act(() => socket.emit(envelope("task_graph_changed", 45)));
    expect(result.current.snapshot?.revision).toBe(43);
    expect(result.current.controlsEnabled).toBe(false);
    expect(send.mock.calls.filter(([command]) => command.type === "get_task_graph_snapshot")).toHaveLength(2);
    act(() => socket.emit(envelope("task_graph_changed", 46)));
    expect(send.mock.calls.filter(([command]) => command.type === "get_task_graph_snapshot")).toHaveLength(2);
    act(() => socket.emit(envelope("task_graph_snapshot", 42)));
    expect(result.current.snapshot?.revision).toBe(43);
    expect(result.current.controlsEnabled).toBe(false);
    act(() => socket.emit(envelope("task_graph_snapshot", 45)));
    expect(result.current.snapshot?.revision).toBe(45);
    expect(result.current.controlsEnabled).toBe(true);
  });

  it("refetches the canonical snapshot after socket reconnection", () => {
    const socket = createSocket();
    const send = vi.fn();
    const { result } = renderHook(() => useTaskGraphView({ workItemId: "work-1", send, subscribe: socket.subscribe }));
    act(() => socket.emit(envelope("task_graph_snapshot", 42)));
    expect(result.current.controlsEnabled).toBe(true);
    act(() => socket.emit({ type: "socket_reconnected" }));
    expect(send.mock.calls.filter(([command]) => command.type === "get_task_graph_snapshot")).toHaveLength(2);
    expect(result.current.controlsEnabled).toBe(false);
    act(() => socket.emit(envelope("task_graph_snapshot", 43)));
    expect(result.current.controlsEnabled).toBe(true);
  });

  it("keeps a prepared plan visible across reconnect and fences approval until refetch", () => {
    const socket = createSocket();
    const send = vi.fn();
    const { result } = renderHook(() => useTaskGraphView({
      workItemId: "work-1", send, subscribe: socket.subscribe,
    }));
    const snapshot = planSnapshot(1);
    act(() => socket.emit({ topic: "work-item:work-1", type: "task_graph_plan_snapshot",
      workItemId: "work-1", revision: 1, snapshot, timestamp: 1 }));
    expect(result.current.planSnapshot?.state).toBe("ready");
    expect(result.current.planControlsEnabled).toBe(true);
    act(() => result.current.approvePlan());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "approve_task_graph_plan", proposalId: "proposal-1",
      expectedProposalRevision: 1,
    }));

    act(() => socket.emit({ type: "socket_reconnected" }));
    expect(result.current.planSnapshot?.proposalId).toBe("proposal-1");
    expect(result.current.planControlsEnabled).toBe(false);
    expect(result.current.stale).toBe(true);
    const approvals = send.mock.calls.filter(([command]) => command.type === "approve_task_graph_plan").length;
    act(() => result.current.approvePlan());
    expect(send.mock.calls.filter(([command]) => command.type === "approve_task_graph_plan"))
      .toHaveLength(approvals);
    act(() => socket.emit({ topic: "work-item:work-1", type: "task_graph_plan_snapshot",
      workItemId: "work-1", revision: 2, snapshot: planSnapshot(2), timestamp: 2 }));
    expect(result.current.planControlsEnabled).toBe(true);
  });

  it("accepts an adjacent successor proposal on the shared projection sequence", () => {
    const first = taskGraphPlanSnapshotViewSchema.parse(planSnapshot(1));
    const successor = taskGraphPlanSnapshotViewSchema.parse({ ...planSnapshot(2),
      proposalId: "proposal-2", proposalRevision: 2,
      baseProposalRevision: 1, objective: "Improved graph plan" });
    const next = foldTaskGraphPlan({ workItemId: "work-1", snapshot: first }, {
      topic: "work-item:work-1", type: "task_graph_plan_changed",
      workItemId: "work-1", revision: 2, snapshot: successor,
      cause: "plan_submitted", timestamp: 2,
    });

    expect(next.snapshot).toMatchObject({
      proposalId: "proposal-2", revision: 2, objective: "Improved graph plan",
    });
    expect(next.refetch).toBe(false);
  });
});

function planSnapshot(revision: number) {
  return { proposalId: "proposal-1", workItemId: "work-1", primaryRunKey: "primary",
    revision, proposalRevision: 1, baseProposalRevision: null, state: "ready", mode: "plan",
    objective: "Ship the graph", acceptanceCriteria: ["done"], assumptions: [], questions: [],
    workPacketId: null,
    steps: [{ key: "build", nodeId: "node-1", title: "Build", objective: "Build it",
      acceptanceCriteria: ["passes"], dependsOn: [], contextSelectors: [],
      executorClass: "standard", risk: "low", requiresApproval: false }],
    materializedRevisionId: "revision-1", graphRunId: null, sourceSnapshotId: "source-1",
    autoStartEligible: true, canStart: true, error: null, updatedAt: revision } as const;
}

describe("graphActionToCommand", () => {
  it("maps run and attempt controls to canonical revision-fenced commands", () => {
    expect(graphActionToCommand({
      type: "pause", requestId: "req-1", graphRunId: "run-1",
      expectedRunRevision: 9, nodeId: null, currentAttemptId: null,
    },"work-1")).toEqual({
      type: "pause_task_graph_run", requestId: "req-1", workItemId:"work-1",runId: "run-1",
      expectedRunRevision: 9,
    });
    expect(graphActionToCommand({
      type: "retry", requestId: "req-2", graphRunId: "run-1",
      expectedRunRevision: 9, nodeId: "node-1", currentAttemptId: "attempt-3",
    },"work-1")).toEqual({
      type: "retry_task_node", requestId: "req-2", workItemId:"work-1",runId: "run-1",
      expectedRunRevision: 9, nodeId: "node-1", currentAttemptId: "attempt-3",
    });
    expect(graphActionToCommand({
      type: "resume", requestId: "req-3", graphRunId: "run-1",
      expectedRunRevision: 10, nodeId: null, currentAttemptId: null,
    },"work-1")?.type).toBe("resume_task_graph_run");
    expect(graphActionToCommand({
      type: "cancel_run", requestId: "req-4", graphRunId: "run-1",
      expectedRunRevision: 10, nodeId: null, currentAttemptId: null,
    },"work-1")?.type).toBe("cancel_task_graph_run");
    expect(graphActionToCommand({
      type: "cancel_attempt", requestId: "req-5", graphRunId: "run-1",
      expectedRunRevision: 10, nodeId: "node-1", currentAttemptId: "attempt-3",
    },"work-1")).toEqual(expect.objectContaining({
      type: "cancel_task_attempt", runId: "run-1",workItemId:"work-1",
      expectedRunRevision: 10, currentAttemptId: "attempt-3",
    }));
    expect(graphActionToCommand({
      type:"adjudicate",requestId:"req-6",graphRunId:"run-1",
      expectedRunRevision:10,nodeId:"node-1",currentAttemptId:"attempt-3",
      decision:"retry",reason:"The verifier omitted evidence.",guidance:"Run the suite.",
    },"work-1")).toEqual({type:"adjudicate_task_node",requestId:"req-6",
      workItemId:"work-1",runId:"run-1",expectedRunRevision:10,nodeId:"node-1",
      currentAttemptId:"attempt-3",adjudication:"retry",
      reason:"The verifier omitted evidence.",guidance:"Run the suite."});
  });
});
