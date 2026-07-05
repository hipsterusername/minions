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

function renderSystemGraph(socket = makeSocket()) {
  const node: CanvasNode = {
    id: "system-graph-test",
    type: "system-graph",
    position: { x: 0, y: 0 },
    size: { width: 640, height: 480 },
    data: { sessionKey: "leader-1" },
  };
  const props: NodeRenderProps = {
    node,
    isSelected: false,
    onUpdateData: vi.fn(),
    socketSend: socket.send,
    socketSubscribe: socket.subscribe,
  };
  render(<SystemGraphNodeRenderer {...props} />);
  return socket;
}

describe("SystemGraphNodeRenderer", () => {
  it("fetches and renders the system graph", async () => {
    const socket = renderSystemGraph();

    await waitFor(() => {
      expect(socket.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "get_system_graph",
          sessionKey: "leader-1",
        }),
      );
    });

    const request = socket.send.mock.calls[0]![0] as { requestId: string };
    socket.emit(sessionTopic("leader-1"), {
      topic: sessionTopic("leader-1"),
      type: "control_response",
      command: "get_system_graph",
      sessionKey: "leader-1",
      requestId: request.requestId,
      success: true,
      graph: {
        nodes: [
          {
            id: "capability.workspace_management",
            type: "capability",
            label: "Workspace Management",
            summary: "Keeps task execution scoped to the right worktree.",
            risk: "high",
            freshness: "stale",
            activePackets: ["packet.ui-graph-node"],
          },
          {
            id: "flow.review_merge",
            type: "flow",
            label: "Review Merge",
            summary: "Checks changes before integration.",
            risk: "medium",
            freshness: "fresh",
          },
          {
            id: "constraint.merge_gate",
            type: "constraint",
            label: "Merge gate must pass",
            risk: "critical",
            freshness: "unknown",
          },
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
      },
      loadErrors: [],
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Workspace Management" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Inspect Review Merge" })).toBeInTheDocument();
    expect(screen.getByText("Keeps task execution scoped to the right worktree.")).toBeInTheDocument();
    expect(screen.getByText("packet.ui-graph-node")).toBeInTheDocument();
  });

  it("filters by elevated risk", async () => {
    const socket = renderSystemGraph();

    await waitFor(() => expect(socket.send).toHaveBeenCalled());
    const request = socket.send.mock.calls[0]![0] as { requestId: string };
    socket.emit(sessionTopic("leader-1"), {
      topic: sessionTopic("leader-1"),
      type: "control_response",
      command: "get_system_graph",
      sessionKey: "leader-1",
      requestId: request.requestId,
      success: true,
      graph: {
        nodes: [
          {
            id: "capability.high_risk",
            type: "capability",
            label: "High Risk Capability",
            risk: "high",
            freshness: "unknown",
          },
          {
            id: "flow.low_risk",
            type: "flow",
            label: "Low Risk Flow",
            risk: "low",
            freshness: "unknown",
          },
        ],
        edges: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Low Risk Flow" })).toBeInTheDocument();
    });

    const filters = screen.getByLabelText("System graph filters");
    fireEvent.click(within(filters).getByRole("button", { name: "Risk" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Inspect Low Risk Flow" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Inspect High Risk Capability" })).toBeInTheDocument();
  });
});
