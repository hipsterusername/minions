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
    { id: "domain.workspace", type: "domain", label: "Workspace", freshness: "unknown" },
    { id: "domain.rendering", type: "domain", label: "Rendering", freshness: "unknown" },
    {
      id: "capability.workspace_management",
      type: "capability",
      label: "Workspace Management",
      summary: "Keeps task execution scoped to the right worktree.",
      risk: "high",
      freshness: "stale",
      domain: "domain.workspace",
      activePackets: ["packet.ui-graph-node"],
      usage: { recentPacketCount: 0, unusedInLastPackets: 30, lastUsedAt: 1000 },
    },
    { id: "capability.rendering", type: "capability", domain: "domain.rendering", label: "Rendering", risk: "low", freshness: "fresh" },
    { id: "flow.review_merge", type: "flow", domain: "domain.workspace", label: "Review Merge", risk: "medium", freshness: "fresh" },
    { id: "constraint.merge_gate", type: "constraint", domain: "domain.workspace", scope: "targeted", label: "Merge gate must pass", risk: "critical", freshness: "unknown" },
    { id: "constraint.secure_defaults", type: "constraint", domain: "domain.workspace", scope: "global", label: "Secure defaults", risk: "high", freshness: "fresh" },
    { id: "constraint.workspace_policy", type: "constraint", domain: "domain.workspace", scope: "domain", label: "Workspace policy", risk: "medium", freshness: "fresh" },
    {
      id: "surface.canvas",
      type: "surface",
      label: "Canvas",
      summary: "Infinite canvas UI",
      freshness: "fresh",
      suggestedFiles: ["src/Canvas.tsx"],
    },
    { id: "surface.mobile", type: "surface", label: "Mobile", freshness: "stale", risk: "medium" },
  ],
  edges: [
    {
      id: "flow.review_merge->implements->capability.workspace_management",
      source: "flow.review_merge",
      target: "capability.workspace_management",
      relation: "implements",
    },
    {
      id: "constraint.merge_gate->guards->capability.workspace_management",
      source: "constraint.merge_gate",
      target: "capability.workspace_management",
      relation: "guards",
    },
    {
      id: "workspace->bridge->rendering",
      source: "capability.workspace_management",
      target: "capability.rendering",
      relation: "bridge",
      summary: "Rendering consumes the workspace lifecycle contract.",
    },
    {
      id: "workspace->canvas",
      source: "capability.workspace_management",
      target: "surface.canvas",
      relation: "entry_point",
      files: ["src/nodes/LeaderNode.tsx"],
      tests: ["src/nodes/LeaderNode.test.tsx"],
      summary: "Create a leader from the canvas.",
    },
    {
      id: "workspace->mobile",
      source: "capability.workspace_management",
      target: "surface.mobile",
      relation: "entry_point",
      files: ["src/mobile/LaunchScreen.tsx"],
      tests: ["src/mobile/LaunchScreen.test.tsx"],
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

  it("groups browse cards by domain and filters to a selected domain", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);

    expect(screen.getByRole("navigation", { name: "Domains" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Workspace capability" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Rendering capability" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Browse Workspace" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Inspect Rendering" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Inspect Workspace Management" })).toBeInTheDocument();
  });

  it("groups domainless surfaces under Cross-cutting", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Surfaces" }));

    expect(await screen.findByRole("region", { name: "Cross-cutting surface" })).toBeInTheDocument();
  });

  it("offers Surface as a primary row", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);

    fireEvent.click(screen.getByRole("button", { name: "Surfaces" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Canvas" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Inspect Mobile" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Rendering" })).not.toBeInTheDocument();
  });

  it("renders sibling surface lanes with each entry point's files and tests", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));

    const lanes = await screen.findByLabelText("Surface lanes");
    expect(within(lanes).getByText("Canvas")).toBeInTheDocument();
    expect(within(lanes).getByText("Mobile")).toBeInTheDocument();
    expect(within(lanes).getByRole("button", { name: "Copy src/nodes/LeaderNode.tsx" })).toBeInTheDocument();
    expect(within(lanes).getByRole("button", { name: "Copy src/nodes/LeaderNode.test.tsx" })).toBeInTheDocument();
    expect(within(lanes).getByRole("button", { name: "Copy src/mobile/LaunchScreen.tsx" })).toBeInTheDocument();
  });

  it("shows every capability entry point and suggested files in the surface inverse view", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Surfaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Canvas" }));

    const inverse = await screen.findByLabelText("Surface capability entry points");
    expect(within(inverse).getByText("Workspace Management")).toBeInTheDocument();
    expect(within(inverse).getByRole("button", { name: "Copy src/Canvas.tsx" })).toBeInTheDocument();
    expect(within(inverse).getByRole("button", { name: "Copy src/nodes/LeaderNode.tsx" })).toBeInTheDocument();
    expect(within(inverse).getByRole("button", { name: "Copy src/nodes/LeaderNode.test.tsx" })).toBeInTheDocument();
  });

  it("uses the entry-point relationship filter to hide surface lanes", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));
    await screen.findByLabelText("Surface lanes");

    fireEvent.click(screen.getByRole("button", { name: "entry point relationships" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Surface lanes")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Inspect Canvas" })).not.toBeInTheDocument();
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
    // The cross-domain capability is pulled in only through its typed bridge.
    const related = screen.getByLabelText("Related objects");
    expect(within(related).getByRole("button", { name: "Inspect Rendering" })).toHaveClass("sg-card-relation-bridge");

    // Inspector fills with the selected object's attributes.
    expect(screen.getByText("Keeps task execution scoped to the right worktree.")).toBeInTheDocument();
    expect(screen.getByText("unused 30")).toBeInTheDocument();
    expect(screen.getByText("packet.ui-graph-node")).toBeInTheDocument();
  });

  it("shows scope-applied constraints as badges rather than relationship cards", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));

    const panel = await screen.findByLabelText("Constraints that apply by scope");
    expect(within(panel).getByText(/Secure defaults/)).toBeInTheDocument();
    expect(within(panel).getByText(/Workspace policy/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Inspect Secure defaults" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Object inspector")).getByText("Secure defaults (global scope)")).toBeInTheDocument();
  });

  it("renders a dashed bridge group reason in the row and inspector", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));

    const related = screen.getByLabelText("Related objects");
    expect(await within(related).findByText("Rendering consumes the workspace lifecycle contract.")).toBeInTheDocument();
    expect(within(related).getByRole("button", { name: "Inspect Rendering" })).toHaveClass("sg-card-relation-bridge");
    expect(within(screen.getByLabelText("Object inspector")).getByText("Rendering consumes the workspace lifecycle contract.")).toBeInTheDocument();
  });

  it("shows entry-point traceability and related flows and constraints in the inspector", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));

    const inspector = screen.getByLabelText("Object inspector");
    await waitFor(() => {
      expect(within(inspector).getByRole("button", { name: "Copy src/nodes/LeaderNode.tsx" })).toBeInTheDocument();
    });
    expect(within(inspector).getByRole("button", { name: "Copy src/nodes/LeaderNode.test.tsx" })).toBeInTheDocument();
    expect(within(inspector).getByText("Review Merge")).toBeInTheDocument();
    expect(within(inspector).getByText("Merge gate must pass")).toBeInTheDocument();
  });

  it("hides a relation group when its legend toggle is turned off", async () => {
    const socket = renderSystemGraph();
    await loadRich(socket);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Workspace Management" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Review Merge" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "implements relationships" }));

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
