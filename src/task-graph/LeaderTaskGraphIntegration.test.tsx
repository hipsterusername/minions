import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SocketSubscribe } from "../use-socket.ts";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import { LeaderNodeRenderer, LEADER_DEFAULT_DATA, type LeaderData } from "../nodes/LeaderNode.tsx";
import { createGraphFixture } from "./fixtures.ts";

describe("LeaderNode task graph integration", () => {
  it("shows the active WorkItem graph summary and launches the inspector without persisting it", () => {
    const listeners = new Map<string, Set<(message: unknown) => void>>();
    const subscribe = Object.assign(
      ((topic: string, next: (message: unknown) => void) => {
        const topicListeners = listeners.get(topic) ?? new Set();
        topicListeners.add(next);
        listeners.set(topic, topicListeners);
        return () => { topicListeners.delete(next); };
      }) as unknown as SocketSubscribe,
      { supportsTopics: true as const },
    );
    const send = vi.fn();
    const update = vi.fn();
    const data: LeaderData = {
      ...LEADER_DEFAULT_DATA,
      workItemId: "work-1",
      taskName: "Explain the execution handoff",
      taskPlan: [{
        taskId: "node-1",
        title: "Inspect the runtime",
        description: "Map the canonical graph projection.",
        priority: "high",
        status: "running",
        executor: "minion",
        minionSessionKey: "session-1",
        result: null,
        cost: 0.01,
        createdAt: 1,
        completedAt: null,
        sessionSummary: "",
      }],
    };
    const node: CanvasNode = {
      id: "leader-graph", type: "leader", position: { x: 0, y: 0 },
      size: { width: 480, height: 500 }, data,
    };
    const props: NodeRenderProps = {
      node, isSelected: false, onUpdateData: update,
      socketSend: send, socketSubscribe: subscribe,
    };
    render(<div data-testid="transformed-canvas-host" style={{ transform: "translate3d(120px, 80px, 0) scale(0.8)" }}>
      <LeaderNodeRenderer {...props} />
    </div>);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "get_task_graph_snapshot", workItemId: "work-1",
    }));
    act(() => {
      for (const next of listeners.get("work-item:work-1") ?? []) next({
        topic: "work-item:work-1", type: "task_graph_snapshot", workItemId: "work-1",
        runId:"run-graph-1",revision:42,cause:"command_snapshot",
        snapshot: createGraphFixture(10), timestamp: 1,
      });
    });

    const canvasHost = screen.getByTestId("transformed-canvas-host");
    const openGraph = screen.getByRole("button", { name: "Open graph" });
    expect(canvasHost).toContainElement(openGraph);
    expect(canvasHost.querySelectorAll(".tg-summary-strip")).toHaveLength(1);
    expect(canvasHost.querySelector(".tg-summary__leader-mark")).toHaveTextContent("");
    expect(canvasHost.querySelector(".tg-summary__leader-mark svg.lucide-workflow")).toHaveAttribute("aria-hidden", "true");
    expect(canvasHost.querySelector(".tg-mini-flow, .tg-summary__stats, .tg-summary__foot")).not.toBeInTheDocument();
    expect(screen.getByText("10-node research graph")).toBeInTheDocument();
    fireEvent.click(openGraph);
    const inspector = screen.getByRole("dialog", { name: /10-node research graph/ });
    expect(inspector).toBeInTheDocument();
    expect(inspector.querySelector(".tg-inspector__mark")).toHaveTextContent("");
    expect(inspector.querySelector(".tg-inspector__mark svg.lucide-workflow")).toHaveAttribute("aria-hidden", "true");
    expect(canvasHost).not.toContainElement(inspector);
    const inspectorOverlay = inspector.closest("[data-viewport-overlay]");
    expect(inspectorOverlay?.parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: /Inspect the runtime.*runtime node/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "pause_task_graph_run", workItemId: "work-1", runId: "run-graph-1",
      expectedRunRevision: 42,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Close graph inspector" }));
    expect(screen.queryByRole("dialog", { name: /10-node research graph/ })).not.toBeInTheDocument();
    expect(inspectorOverlay).not.toBeInTheDocument();
    expect(canvasHost).toContainElement(openGraph);
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ graphRunId: "run-graph-1" }));
  });

  it("renders a canonical plan without legacy taskPlan and starts the fenced proposal", () => {
    const listeners = new Map<string, Set<(message: unknown) => void>>();
    const subscribe = Object.assign(
      ((topic: string, next: (message: unknown) => void) => {
        const topicListeners = listeners.get(topic) ?? new Set();
        topicListeners.add(next); listeners.set(topic, topicListeners);
        return () => { topicListeners.delete(next); };
      }) as unknown as SocketSubscribe,
      { supportsTopics: true as const },
    );
    const send = vi.fn(); const update = vi.fn();
    const data: LeaderData = { ...LEADER_DEFAULT_DATA, workItemId: "work-plan",
      taskName: "Build graph planning", taskPlan: [] };
    render(<LeaderNodeRenderer node={{ id: "leader-plan", type: "leader",
      position: { x: 0, y: 0 }, size: { width: 480, height: 500 }, data }}
      isSelected={false} onUpdateData={update} socketSend={send} socketSubscribe={subscribe} />);

    act(() => {
      for (const next of listeners.get("work-item:work-plan") ?? []) next({
        topic: "work-item:work-plan", type: "task_graph_plan_snapshot",
        workItemId: "work-plan", revision: 1, timestamp: 1,
        snapshot: { proposalId: "proposal-1", workItemId: "work-plan", primaryRunKey: "primary",
          revision: 1, proposalRevision: 1, baseProposalRevision: null, state: "ready", mode: "plan",
          objective: "Build graph planning", acceptanceCriteria: ["Verified"],
          assumptions: ["Existing runtime remains canonical"], questions: [], workPacketId: null,
          steps: [{ key: "build", nodeId: "node-1", title: "Build coordinator",
            objective: "Implement the coordinator", acceptanceCriteria: ["Tests pass"],
            dependsOn: [], contextSelectors: ["runtime"],inputBindings:{},outputSchemas:{},
            outputExamples:{},executorClass: "standard",
            risk: "low", requiresApproval: false }], materializedRevisionId: "revision-1",
          graphRunId: null, sourceSnapshotId: "source-1", autoStartEligible: true,
          canStart: true, error: null, updatedAt: 1 },
      });
    });

    expect(screen.getByText("Plan ready")).toBeInTheDocument();
    const proposal = screen.getByRole("region", { name: /Execution plan Build graph planning/ });
    expect(proposal.querySelector(".tg-summary__leader-mark")).toHaveTextContent("");
    expect(proposal.querySelector("svg.lucide-clipboard-list")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Build coordinator")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const planDialog = screen.getByRole("dialog", { name: /Execution plan: Build graph planning/ });
    expect(planDialog).toBeInTheDocument();
    expect(planDialog.querySelector(".tg-summary__leader-mark")).toHaveTextContent("");
    expect(planDialog.querySelector("svg.lucide-clipboard-list")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start work" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "approve_task_graph_plan", workItemId: "work-plan",
      proposalId: "proposal-1", expectedProposalRevision: 1,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    fireEvent.click(screen.getByTestId("drawer-tab-graph"));
    expect(screen.getByTestId("drawer-panel-graph")).toHaveTextContent("1 planned steps");
    fireEvent.click(screen.getByRole("button", { name: "Open graph details" }));
    expect(screen.getByRole("dialog", { name: /Execution plan: Build graph planning/ }))
      .toBeInTheDocument();
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ proposalId: "proposal-1" }));
  });
});
