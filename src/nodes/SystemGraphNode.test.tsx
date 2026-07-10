import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { sessionTopic } from "../../shared/ws-envelope.ts";
import { SystemGraphNodeRenderer } from "./SystemGraphNode.tsx";
import type { CanvasNode, NodeRenderProps } from "../types.ts";
import type { SocketSubscribe } from "../use-socket.ts";

type Listener = (msg: unknown) => void;

function makeSocket() {
  const listeners = new Map<string, Set<Listener>>();
  const subscribe = Object.assign(
    ((first: string | Listener, second?: Listener) => {
      const topic = typeof first === "string" ? first : "*";
      const fn = typeof first === "string" ? second! : first;
      const set = listeners.get(topic) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(topic, set);
      return () => {
        set.delete(fn);
      };
    }) as SocketSubscribe,
    { supportsTopics: true as const },
  );
  return {
    send: vi.fn(),
    subscribe,
    emit(topic: string, msg: unknown) {
      for (const fn of listeners.get(topic) ?? []) fn(msg);
    },
  };
}

function renderSystemGraph(
  socket = makeSocket(),
  onResize?: NodeRenderProps["onResize"],
) {
  const node: CanvasNode = {
    id: "system-graph-test",
    type: "system-graph",
    position: { x: 0, y: 0 },
    size: { width: 720, height: 540 },
    data: { sessionKey: "leader-1" },
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: vi.fn(),
    onResize,
    socketSend: socket.send,
    socketSubscribe: socket.subscribe,
  };
  render(<SystemGraphNodeRenderer {...props} />);
  return socket;
}

function emitGraph(
  socket: ReturnType<typeof makeSocket>,
  nodes: unknown[],
  edges: unknown[] = [],
) {
  const request = socket.send.mock.calls[0]![0] as { requestId: string };
  socket.emit(sessionTopic("leader-1"), {
    topic: sessionTopic("leader-1"),
    type: "control_response",
    command: "get_system_graph",
    sessionKey: "leader-1",
    requestId: request.requestId,
    success: true,
    graph: { nodes, edges },
    loadErrors: [],
  });
}

const richGraph = {
  nodes: [
    {
      id: "capability.workspace_management",
      type: "capability",
      label: "Workspace Management",
      summary: "Keeps task execution scoped to the right worktree.",
      risk: "high",
      freshness: "stale",
      activePackets: ["packet.ui-graph-node"],
      usage: { recentPacketCount: 0, unusedInLastPackets: 30, lastUsedAt: 1000 },
    },
    { id: "capability.rendering", type: "capability", label: "Rendering", risk: "low", freshness: "fresh" },
    { id: "flow.review_merge", type: "flow", label: "Review Merge", risk: "medium", freshness: "fresh" },
    { id: "constraint.merge_gate", type: "constraint", label: "Merge gate must pass", risk: "critical", freshness: "unknown" },
  ],
  edges: [
    {
      id: "capability.workspace_management->linked_flow->flow.review_merge",
      source: "capability.workspace_management",
      target: "flow.review_merge",
      relation: "linked_flow",
    },
    {
      id: "capability.workspace_management->constraint->constraint.merge_gate",
      source: "capability.workspace_management",
      target: "constraint.merge_gate",
      relation: "constraint",
    },
  ],
};

async function loadRich(socket: ReturnType<typeof makeSocket>) {
  await waitFor(() => expect(socket.send).toHaveBeenCalled());
  emitGraph(socket, richGraph.nodes, richGraph.edges);
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Inspect Workspace Management" })).toBeInTheDocument();
  });
}

describe("SystemGraphNodeRenderer", () => {
  it("renders the capability primary row and lets the user switch to flows", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);

    // Capabilities are the default primary row; flows are not shown yet.
    expect(screen.getByRole("button", { name: "Inspect Rendering" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Review Merge" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Flows" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Review Merge" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Inspect Rendering" })).not.toBeInTheDocument();
  });

  it("reveals only the related cards when a primary card is selected", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);

    // Nothing related shown until a card is clicked.
    expect(screen.queryByRole("button", { name: "Inspect Review Merge" })).not.toBeInTheDocument();
    expect(screen.getByText(/Select a capability above/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Review Merge" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Inspect Merge gate must pass" })).toBeInTheDocument();
    // The unrelated capability is NOT pulled into the related area.
    const related = screen.getByLabelText("Related objects");
    expect(within(related).queryByRole("button", { name: "Inspect Rendering" })).not.toBeInTheDocument();

    // Inspector fills with the selected object's attributes.
    expect(screen.getByText("Keeps task execution scoped to the right worktree.")).toBeInTheDocument();
    expect(screen.getByText("unused 30")).toBeInTheDocument();
    expect(screen.getByText("packet.ui-graph-node")).toBeInTheDocument();
  });

  it("hides a relation group when its legend toggle is turned off", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Review Merge" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Flow link relationships" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Inspect Review Merge" })).not.toBeInTheDocument();
    });
    // The constraint group is untouched.
    expect(screen.getByRole("button", { name: "Inspect Merge gate must pass" })).toBeInTheDocument();
  });

  it("filters the primary row with the Risk lens", async () => {
    const socket = renderSystemGraph();
    await waitFor(() => expect(socket.send).toHaveBeenCalled());
    emitGraph(socket, [
      { id: "capability.high", type: "capability", label: "High Risk Capability", risk: "high", freshness: "unknown" },
      { id: "capability.low", type: "capability", label: "Low Risk Capability", risk: "low", freshness: "unknown" },
    ]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Low Risk Capability" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Risk" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Inspect Low Risk Capability" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Inspect High Risk Capability" })).toBeInTheDocument();
  });

  it("renders a resize handle when the canvas provides onResize", () => {
    renderSystemGraph(makeSocket(), vi.fn());
    expect(document.querySelector('[style*="nwse-resize"]')).not.toBeNull();
  });
});
