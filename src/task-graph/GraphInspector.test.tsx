import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createGraphFixture } from "./fixtures.ts";
import { GraphInspector } from "./GraphInspector.tsx";
import { GraphSummaryCard } from "./GraphSummaryCard.tsx";
import { MAX_TOPOLOGY_EDGES, MAX_TOPOLOGY_NODES } from "./model.ts";
import { fitTopologyCamera, layoutDag, Topology } from "./Topology.tsx";
import type { GraphPlanItem, TaskGraphEdgeView } from "./types.ts";

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

function createCrossingFixture() {
  const ids = ["a", "b", "c", "d", "e", "f"] as const;
  const snapshot = createGraphFixture(6);
  snapshot.nodes = snapshot.nodes.map((node, index) => ({
    ...node,
    id: ids[index]!,
    title: `Node ${ids[index]}`,
    criticalPath: false,
    priority: 1,
  }));
  snapshot.edges = [
    ["a", "d"], ["b", "c"], ["d", "e"], ["c", "f"],
  ].map(([source, target], index) => ({
    id: `edge-${index}`,
    source: source!,
    target: target!,
    type: "depends_on" as const,
    state: "ordinary" as const,
  }));
  return snapshot;
}

function adjacentCrossings(
  layout: ReturnType<typeof layoutDag>,
  edges: readonly TaskGraphEdgeView[],
) {
  let crossings = 0;
  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    const left = edges[leftIndex]!;
    const leftSource = layout.byId.get(left.source)!;
    const leftTarget = layout.byId.get(left.target)!;
    for (const right of edges.slice(leftIndex + 1)) {
      const rightSource = layout.byId.get(right.source)!;
      const rightTarget = layout.byId.get(right.target)!;
      if (leftSource.x !== rightSource.x || leftTarget.x !== rightTarget.x) continue;
      if ((leftSource.y - rightSource.y) * (leftTarget.y - rightTarget.y) < 0) crossings += 1;
    }
  }
  return crossings;
}

describe("GraphSummaryCard", () => {
  it("condenses canonical status and progress into one summary strip", () => {
    const open = vi.fn();
    const { container } = render(<GraphSummaryCard snapshot={createGraphFixture(10)} onOpen={open} />);
    expect(screen.getByText("10-node research graph")).toBeInTheDocument();
    expect(screen.getByText("running", { selector: ".tg-run-status" })).toBeInTheDocument();
    expect(screen.getByLabelText(/of 10 logical tasks succeeded/)).toHaveTextContent(/\/10 succeeded/);
    expect(screen.getByText(/running/, { selector: ".tg-summary__signal--running" })).toBeInTheDocument();
    expect(container.querySelectorAll(".tg-summary-strip")).toHaveLength(1);
    expect(container.querySelector(".tg-summary__leader-mark")).toHaveTextContent("");
    expect(container.querySelector(".tg-summary__leader-mark svg.lucide-workflow")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".tg-summary__secondary")).toHaveTextContent(/left.*path/);
    expect(container.querySelector(".tg-summary__goal")).not.toBeInTheDocument();
    expect(container.querySelector(".tg-mini-flow")).not.toBeInTheDocument();
    expect(container.querySelector(".tg-summary__stats")).not.toBeInTheDocument();
    expect(container.querySelector(".tg-summary__foot")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open graph" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps stale state visible without expanding the compact structure", () => {
    const snapshot = createGraphFixture(10);
    snapshot.title = "A deliberately long graph title that must remain a single truncatable line inside a narrow Leader node";
    const { container } = render(<GraphSummaryCard snapshot={snapshot} stale onOpen={vi.fn()} />);

    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    expect(screen.getByText(snapshot.title)).toHaveAttribute("title", snapshot.title);
    expect(container.querySelectorAll(".tg-summary-strip")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open graph" })).toBeInTheDocument();
  });
});

describe("GraphInspector", () => {
  it("mounts as an edge-to-edge workstream focus mode", () => {
    render(<GraphInspector snapshot={createGraphFixture(10)} onClose={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: /10-node research graph/ })).toHaveClass("tg-inspector--fullscreen");
    expect(screen.getByText("Workstream inspector")).toBeInTheDocument();
    expect(screen.getByText("Run objective")).toBeInTheDocument();
    expect(document.body.querySelector(".tg-inspector__mark")).toHaveTextContent("");
    expect(document.body.querySelector(".tg-inspector__mark svg.lucide-workflow")).toHaveAttribute("aria-hidden", "true");
    expect(document.body.querySelector(".tg-backdrop")).toBeInTheDocument();
  });

  it("owns viewport isolation even when invoked below a transformed host", () => {
    render(
      <div data-testid="transformed-host" style={{ transform: "translate(80px, 40px) scale(.7)" }}>
        <GraphInspector snapshot={createGraphFixture(10)} onClose={vi.fn()} onAction={vi.fn()} />
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: /10-node research graph/ });
    const overlay = dialog.closest("[data-viewport-overlay]");
    expect(screen.getByTestId("transformed-host")).not.toContainElement(dialog);
    expect(overlay?.parentElement).toBe(document.body);
  });

  it("foregrounds the minion brief, routed context, withheld sources, and attempt responses", () => {
    const snapshot = createGraphFixture(10);
    snapshot.nodes[7] = {
      ...snapshot.nodes[7]!,
      objective: "Trace the projection gap and ship a bounded fix.",
      constraints: ["Keep typed action dispatch intact."],
      acceptanceCriteria: ["Focused tests pass."],
      context: [
        { sourceId: "leader-brief", contentHash: `sha256:${"a".repeat(64)}`, classification: "internal", content: "Preserve graph controls and selection semantics." },
        { sourceId: "private-review", contentHash: `sha256:${"b".repeat(64)}`, classification: "sensitive", withheld: true },
      ],
      logs: ["raw-technical-log-that-must-not-render"],
      attemptHistory: snapshot.nodes[7]!.attemptHistory.map((attempt, index) => index === 0 ? { ...attempt, response: "I isolated the stale selection path." } : attempt),
    };
    render(<GraphInspector snapshot={snapshot} onClose={vi.fn()} onAction={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
    expect(screen.getByRole("heading", { name: "Minion brief" })).toBeInTheDocument();
    expect(screen.getByText("Trace the projection gap and ship a bounded fix.")).toBeInTheDocument();
    expect(screen.getByText("Preserve graph controls and selection semantics.")).toBeInTheDocument();
    expect(screen.getByText("Content withheld by its sensitive classification.")).toBeInTheDocument();
    expect(screen.getByText("I isolated the stale selection path.")).toBeInTheDocument();
    expect(screen.getByText("No response was recorded for this attempt.")).toBeInTheDocument();
    expect(screen.queryByText("raw-technical-log-that-must-not-render")).not.toBeInTheDocument();
  });

  it("shows useful empty work-context and response states", () => {
    const snapshot = createGraphFixture(10);
    snapshot.nodes[7] = { ...snapshot.nodes[7]!, constraints: [], acceptanceCriteria: [], context: [], attemptHistory: [] };
    render(<GraphInspector snapshot={snapshot} onClose={vi.fn()} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));

    expect(screen.getByText("No additional constraints were routed.")).toBeInTheDocument();
    expect(screen.getByText("No acceptance criteria were declared.")).toBeInTheDocument();
    expect(screen.getByText("No routed context was attached to this task.")).toBeInTheDocument();
    expect(screen.getByText("This task has not started an attempt yet.")).toBeInTheDocument();
  });

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
    render(<GraphInspector snapshot={snapshot} plan={plan} goal="Ship the orchestration model" onClose={vi.fn()} onAction={vi.fn()} />);

    expect(screen.getByText("Ship the orchestration model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Plan task 1.*runtime node/i }));
    expect(screen.getByRole("button", { name: /Plan focus/ })).toBeInTheDocument();
    expect(document.body.querySelectorAll(".tg-flow-node.is-dimmed").length).toBeGreaterThan(0);

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
    const lineageIcons = document.body.querySelectorAll(".tg-lineage-card--source .tg-lineage-icon, .tg-lineage-card--target .tg-lineage-icon");
    expect(lineageIcons).toHaveLength(2);
    expect([...lineageIcons].every((icon) => icon.textContent === "")).toBe(true);
    expect(document.body.querySelector(".tg-lineage-card--source svg.lucide-send")).toHaveAttribute("aria-hidden", "true");
    expect(document.body.querySelector(".tg-lineage-card--target svg.lucide-inbox")).toHaveAttribute("aria-hidden", "true");
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
      expect(screen.queryByRole("complementary", { name: "Authored execution plan" })).not.toBeInTheDocument();
      expect(screen.getByRole("complementary", { name: "Selection details" })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("complementary", { name: "Selection details" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: /10-node research graph/ })).toBeInTheDocument();
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

  it("offers auditable Leader accept, reject, and guided-retry controls",()=>{
    const action=vi.fn();
    const snapshot=createGraphFixture(10);
    snapshot.nodes[7]={...snapshot.nodes[7]!,completionMode:"verification",
      blocker:{category:"policy",explanation:"Verification needs Leader adjudication or a guided retry"},
      adjudication:null};
    render(<GraphInspector snapshot={snapshot} initialTab="topology" onClose={vi.fn()}
      onAction={action} createRequestId={()=>"adjudicate-fixed"}/>);

    fireEvent.click(screen.getByRole("button",{name:/Task 7/}));
    fireEvent.change(screen.getByLabelText("Adjudication reason"),{
      target:{value:"I independently confirmed the acceptance criteria."},
    });
    fireEvent.change(screen.getByLabelText("Retry guidance"),{
      target:{value:"Include the focused test output."},
    });
    expect(screen.getByRole("button",{name:"Reject verification"})).toBeEnabled();
    expect(screen.getByRole("button",{name:"Retry with guidance"})).toBeEnabled();
    fireEvent.click(screen.getByRole("button",{name:"Accept with reason"}));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({type:"adjudicate",
      decision:"accepted",reason:"I independently confirmed the acceptance criteria.",
      requestId:"adjudicate-fixed",graphRunId:"run-graph-1",expectedRunRevision:42,
      nodeId:"node-7",currentAttemptId:"attempt-7-2"}));
  });

  it("clears adjudication drafts when selecting a different node",()=>{
    const snapshot=createGraphFixture(10);
    for (const index of [7,8]) {
      const node=snapshot.nodes[index]!;
      snapshot.nodes[index]={...node,completionMode:"verification",
        currentAttempt:{...node.currentAttempt!,state:"failed"},
        blocker:{category:"policy",explanation:"Verification needs Leader adjudication"},
        adjudication:null};
    }
    render(<GraphInspector snapshot={snapshot} initialTab="topology" onClose={vi.fn()}
      onAction={vi.fn()}/>);

    fireEvent.click(screen.getByRole("button",{name:/Task 7/}));
    fireEvent.change(screen.getByLabelText("Adjudication reason"),{
      target:{value:"Reason for task seven."},
    });
    expect(screen.getByRole("button",{name:"Accept with reason"})).toBeEnabled();

    fireEvent.click(screen.getByRole("button",{name:/Task 8/}));
    expect(screen.getByLabelText("Adjudication reason")).toHaveValue("");
    expect(screen.getByLabelText("Retry guidance")).toHaveValue("");
    expect(screen.getByRole("button",{name:"Accept with reason"})).toBeDisabled();
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
    render(<GraphInspector snapshot={snapshot} initialTab="queue" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(document.body.querySelectorAll(".tg-queue-row").length).toBeGreaterThan(0);
    expect(document.body.querySelectorAll(".tg-queue-row").length).toBeLessThanOrEqual(15);
    fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
    expect(document.body.querySelectorAll(".tg-flow-node").length).toBeGreaterThan(0);
    expect(document.body.querySelectorAll(".tg-flow-node").length).toBeLessThanOrEqual(MAX_TOPOLOGY_NODES);
    expect(document.body.querySelectorAll(".tg-flow-edge:not(.tg-flow-edge--expansion)").length).toBeLessThanOrEqual(MAX_TOPOLOGY_EDGES);
    expect(screen.getByText(/nodes aggregated/)).toBeInTheDocument();
  });
});

describe("Topology scene", () => {
  it("fits and centers a scene within a large viewport", () => {
    const camera = fitTopologyCamera(
      { width: 1_000, height: 520 },
      { width: 1_600, height: 900 },
    );

    expect(camera.scale).toBe(1.25);
    expect(camera.offsetX).toBe(175);
    expect(camera.offsetY).toBe(125);
    expect(camera.stageWidth).toBe(1_600);
    expect(camera.stageHeight).toBe(900);
  });

  it("preserves a legible minimum scale and overflow on narrow viewports", () => {
    const camera = fitTopologyCamera(
      { width: 1_400, height: 520 },
      { width: 420, height: 360 },
    );

    expect(camera.scale).toBe(0.72);
    expect(camera.offsetX).toBe(28);
    expect(camera.offsetY).toBe(44);
    expect(camera.stageWidth).toBe(1_064);
    expect(camera.stageHeight).toBe(462.4);
  });

  it("uses the limiting viewport axis when fitting between scale bounds", () => {
    const camera = fitTopologyCamera(
      { width: 1_000, height: 520 },
      { width: 1_000, height: 700 },
    );

    expect(camera.scale).toBe(0.944);
    expect(camera.offsetX).toBe(28);
    expect(camera.offsetY).toBe(104.56);
  });

  it("lays out the crossing fixture deterministically with no adjacent crossings", () => {
    const snapshot = createCrossingFixture();
    const layout = layoutDag(snapshot.nodes, snapshot.edges);
    const reordered = layoutDag(snapshot.nodes.toReversed(), snapshot.edges.toReversed());

    expect(adjacentCrossings(layout, snapshot.edges)).toBe(0);
    expect([...layout.byId].map(([id, item]) => [id, item.x, item.y]).toSorted())
      .toEqual([...reordered.byId].map(([id, item]) => [id, item.x, item.y]).toSorted());
  });

  it("renders edge and node layers against one explicit scene boundary", () => {
    const snapshot = createCrossingFixture();
    const { container } = render(
      <Topology snapshot={snapshot} filter="all" selectedNodeId={null} onSelect={vi.fn()} />,
    );
    const scene = container.querySelector<HTMLElement>(".tg-flow-scene")!;
    const stage = scene.parentElement!;
    const edges = scene.querySelector<SVGElement>(":scope > .tg-flow-layer--edges")!;
    const nodes = scene.querySelector<HTMLElement>(":scope > .tg-flow-layer--nodes")!;

    expect(scene.dataset["sceneWidth"]).toBeTruthy();
    expect(scene.dataset["sceneHeight"]).toBeTruthy();
    expect(edges).toHaveAttribute("width", scene.dataset["sceneWidth"]);
    expect(edges).toHaveAttribute("height", scene.dataset["sceneHeight"]);
    expect(nodes.querySelectorAll(".tg-flow-node")).toHaveLength(snapshot.nodes.length);
    expect(stage).toHaveClass("tg-flow-canvas");
    expect(stage.parentElement).toHaveClass("tg-flow-scroll");
    expect(scene.style.transform).toMatch(/^translate\(.+px, .+px\) scale\(.+\)$/);
    expect(container.querySelector(".tg-topology__notice")?.parentElement).not.toBe(stage.parentElement);
  });
});
