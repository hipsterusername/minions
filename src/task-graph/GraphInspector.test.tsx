import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createGraphFixture } from "./fixtures.ts";
import { GraphInspector } from "./GraphInspector.tsx";
import { GraphSummaryCard } from "./GraphSummaryCard.tsx";
import { MAX_TOPOLOGY_EDGES, MAX_TOPOLOGY_NODES } from "./model.ts";
import type { GraphPlanItem } from "./types.ts";

function createPlan(count = 4): GraphPlanItem[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `node-${index}`,
    title: `Plan task ${index}`,
    description: `Canonical plan item ${index}`,
    priority: index === 0 ? "critical" : "medium",
    status: index === 0 ? "running" : "planned",
    executor: index === 0 ? "leader" : "minion",
    minionSessionKey: index === 0 ? null : `session-${index}`,
    result: null,
    cost: index / 10,
  }));
}

describe("GraphSummaryCard", () => {
  it("answers compact status, cost, budget, and critical-path questions", () => {
    const open = vi.fn();
    render(<GraphSummaryCard snapshot={createGraphFixture(10)} onOpen={open} />);
    expect(screen.getByText("running", { selector: ".tg-run-status" })).toBeInTheDocument();
    expect(screen.getByText(/spent/)).toBeInTheDocument();
    expect(screen.getByText(/critical path/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open graph" }));
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("GraphInspector", () => {
  it("shows all overview operator answers and supports keyboard tabs", () => {
    render(<GraphInspector snapshot={createGraphFixture(10)} initialTab="overview" onClose={vi.fn()} onAction={vi.fn()} createRequestId={() => "request-1"} />);
    expect(screen.getByRole("dialog", { name: /10-node research graph/ })).toBeInTheDocument();
    for (const label of ["Logical progress", "Running attempts", "Ready / capacity", "Blocked", "Logical failures", "Attempt-only failures", "Verified outputs", "Unverified outputs", "Cost & budget", "Completion-determining chain"]) expect(screen.getByText(label)).toBeInTheDocument();
    const overview = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Work queue" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the authored plan synchronized with flow and plan-map projections", () => {
    const snapshot = createGraphFixture(20);
    const plan = createPlan();
    const { container } = render(<GraphInspector snapshot={snapshot} plan={plan} goal="Ship the orchestration model" onClose={vi.fn()} onAction={vi.fn()} />);

    expect(screen.getByText("Ship the orchestration model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Plan task 1.*runtime node/i }));
    expect(screen.getByRole("button", { name: /Plan focus/ })).toBeInTheDocument();
    expect(container.querySelectorAll(".tg-flow-node.is-dimmed").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Plan map" }));
    expect(screen.getByText("4/4 mapped")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Checkpoint" })).toBeInTheDocument();
  });

  it("projects evidence as an inspectable source-to-checkpoint-to-consumer transfer", () => {
    const snapshot = createGraphFixture(20);
    const evidence = snapshot.evidence[0]!;
    evidence.consumerNodeIds = ["node-14"];
    render(<GraphInspector snapshot={snapshot} initialTab="evidence" onClose={vi.fn()} onAction={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Context lineage" })).toBeInTheDocument();
    expect(screen.getAllByText(evidence.sourceSnapshot).length).toBeGreaterThan(0);
    expect(screen.getAllByText(evidence.artifactId).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "C1" }));
    expect(screen.getByRole("heading", { level: 3, name: evidence.artifactId })).toBeInTheDocument();
  });

  it("starts narrow layouts with both disclosure rails collapsed and keeps them operable", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 720 });
    try {
      render(<GraphInspector snapshot={createGraphFixture(10)} plan={createPlan()} onClose={vi.fn()} onAction={vi.fn()} />);
      expect(screen.queryByRole("complementary", { name: "Authored execution plan" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));
      expect(screen.getByRole("complementary", { name: "Authored execution plan" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Expand details" }));
      expect(screen.getByRole("complementary", { name: "Selection details" })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("keeps logical, attempt, verification, and blocker encodings distinct", () => {
    const snapshot = createGraphFixture(10);
    render(<GraphInspector snapshot={snapshot} initialTab="topology" onClose={vi.fn()} onAction={vi.fn()} />);
    const state = screen.getByLabelText(/Logical pending; attempt blocked; verification not_required; blocker input/);
    expect(state).toHaveClass("tg-logical--pending", "tg-attempt--blocked");
    expect(within(state).getByTitle("Verification: not_required")).toBeInTheDocument();
    expect(within(state).getByText("input")).toHaveClass("tg-blocker");
  });

  it("fences node and run controls with revision and current attempt identity", () => {
    const action = vi.fn();
    render(<GraphInspector snapshot={createGraphFixture(10)} initialTab="topology" onClose={vi.fn()} onAction={action} createRequestId={() => "request-fixed"} />);
    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ type: "retry", requestId: "request-fixed", graphRunId: "run-graph-1", expectedRunRevision: 42, nodeId: "node-7", currentAttemptId: "attempt-7-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ type: "pause", expectedRunRevision: 42, nodeId: null, currentAttemptId: null }));
  });

  it("offers fenced retry instead of cancellation for a backoff attempt", () => {
    const action = vi.fn();
    const snapshot = createGraphFixture(10);
    snapshot.nodes[7] = {
      ...snapshot.nodes[7]!,
      currentAttempt: { ...snapshot.nodes[7]!.currentAttempt!, state: "backoff" },
    };
    const { rerender } = render(
      <GraphInspector snapshot={snapshot} initialTab="topology" controlsEnabled={false} onClose={vi.fn()} onAction={action} createRequestId={() => "request-backoff"} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel attempt" })).not.toBeInTheDocument();

    rerender(<GraphInspector snapshot={snapshot} initialTab="topology" controlsEnabled onClose={vi.fn()} onAction={action} createRequestId={() => "request-backoff"} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      type: "retry",
      requestId: "request-backoff",
      graphRunId: "run-graph-1",
      expectedRunRevision: 42,
      nodeId: "node-7",
      currentAttemptId: "attempt-7-2",
    }));
  });

  it("keeps queued, running, and blocked attempts cancellable", () => {
    render(<GraphInspector snapshot={createGraphFixture(10)} initialTab="topology" onClose={vi.fn()} onAction={vi.fn()} />);
    for (const task of ["Task 0", "Task 1", "Task 5"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(task) }));
      expect(screen.getByRole("button", { name: "Cancel attempt" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close task details" }));
    }
  });

  it("keeps quiescent distinct from operator-paused and exposes safe run controls", () => {
    const action = vi.fn();
    const snapshot = { ...createGraphFixture(10), status: "quiescent" as const };
    render(<GraphInspector snapshot={snapshot} onClose={vi.fn()} onAction={action} createRequestId={() => "request-fixed"} />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ type: "cancel_run", expectedRunRevision: 42 }));
  });

  it("disables every mutation while the displayed projection is awaiting convergence", () => {
    const action = vi.fn();
    render(<GraphInspector snapshot={createGraphFixture(10)} initialTab="topology" controlsEnabled={false} onClose={vi.fn()} onAction={action} />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(action).not.toHaveBeenCalled();
  });

  it("mounts a bounded queue and topology for 1,000 nodes", () => {
    const snapshot = createGraphFixture(1_000);
    const { container } = render(<GraphInspector snapshot={snapshot} initialTab="queue" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(container.querySelectorAll(".tg-queue-row").length).toBeLessThanOrEqual(15);
    fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
    expect(container.querySelectorAll(".tg-flow-node").length).toBeLessThanOrEqual(MAX_TOPOLOGY_NODES);
    expect(container.querySelectorAll(".tg-flow-edge:not(.tg-flow-edge--expansion)").length).toBeLessThanOrEqual(MAX_TOPOLOGY_EDGES);
    expect(screen.getByText(/nodes aggregated/)).toBeInTheDocument();
  });
});
