import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { toPersistableNodes, useAutosave } from "./use-autosave.ts";
import type { CanvasNode, CanvasTransform } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import { saveProjectState } from "./api.ts";

vi.mock("./api.ts", () => ({
  saveProjectState: vi.fn().mockResolvedValue({ ok: true }),
}));

const saveProjectStateMock = vi.mocked(saveProjectState);

const transform: CanvasTransform = { x: 0, y: 0, scale: 1 };

function Probe({
  projectId,
  nodes,
  graph,
}: {
  projectId: string | null;
  nodes: CanvasNode[];
  graph: GraphDocument;
}) {
  useAutosave(projectId, nodes, graph, transform, 10);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  saveProjectStateMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutosave", () => {
  it("saves the first graph edit after project load", async () => {
    const initialGraph: GraphDocument = { edges: [] };
    const nodes: CanvasNode[] = [];
    const { rerender } = render(
      <Probe projectId={null} nodes={nodes} graph={initialGraph} />,
    );

    rerender(<Probe projectId="project-1" nodes={nodes} graph={initialGraph} />);
    await vi.advanceTimersByTimeAsync(20);
    expect(saveProjectStateMock).not.toHaveBeenCalled();

    const editedGraph: GraphDocument = {
      edges: [
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePortId: "context-out",
          targetNodeId: "b",
          targetPortId: "context-in",
          protocol: "context",
        },
      ],
    };
    rerender(<Probe projectId="project-1" nodes={nodes} graph={editedGraph} />);

    await vi.advanceTimersByTimeAsync(20);

    expect(saveProjectStateMock).toHaveBeenCalledWith("project-1", {
      transform,
      nodes,
      graph: editedGraph,
    });
  });

  it("does not schedule a save for streaming-only node changes", async () => {
    const graph: GraphDocument = { edges: [] };
    const baseNode: CanvasNode = {
      id: "leader-1",
      type: "leader",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        sessionKey: "s1",
        status: "running",
        messages: [],
        streamingText: "",
        streamingBlockIndex: null,
        totalCost: 0,
        turns: 0,
        error: null,
      },
    };

    const { rerender } = render(
      <Probe projectId={null} nodes={[baseNode]} graph={graph} />,
    );
    rerender(<Probe projectId="project-1" nodes={[baseNode]} graph={graph} />);
    await vi.advanceTimersByTimeAsync(20);
    expect(saveProjectStateMock).not.toHaveBeenCalled();

    const streamingNode: CanvasNode = {
      ...baseNode,
      data: {
        ...(baseNode.data as Record<string, unknown>),
        streamingText: "partial token",
        streamingBlockIndex: 0,
      },
    };
    rerender(<Probe projectId="project-1" nodes={[streamingNode]} graph={graph} />);
    await vi.advanceTimersByTimeAsync(20);

    expect(saveProjectStateMock).not.toHaveBeenCalled();
  });

  it("saves a persistable node projection without streaming buffers", async () => {
    const graph: GraphDocument = { edges: [] };
    const node: CanvasNode = {
      id: "leader-1",
      type: "leader",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        sessionKey: "s1",
        status: "running",
        messages: [],
        streamingText: "partial",
        streamingBlockIndex: 0,
        totalCost: 0,
        turns: 0,
        error: null,
      },
    };
    const editedNode: CanvasNode = {
      ...node,
      data: {
        ...(node.data as Record<string, unknown>),
        messages: [{ id: "m1", role: "assistant", content: "Done", timestamp: 1 }],
        streamingText: "new partial",
      },
    };

    const { rerender } = render(
      <Probe projectId={null} nodes={[node]} graph={graph} />,
    );
    rerender(<Probe projectId="project-1" nodes={[node]} graph={graph} />);
    await vi.advanceTimersByTimeAsync(20);

    rerender(<Probe projectId="project-1" nodes={[editedNode]} graph={graph} />);
    await vi.advanceTimersByTimeAsync(20);

    expect(saveProjectStateMock).toHaveBeenCalledWith("project-1", {
      transform,
      nodes: [
        {
          ...editedNode,
          data: {
            sessionKey: "s1",
            status: "running",
            messages: [{ id: "m1", role: "assistant", content: "Done", timestamp: 1 }],
            totalCost: 0,
            turns: 0,
            error: null,
          },
        },
      ],
      graph,
    });
  });
});

describe("toPersistableNodes", () => {
  it("strips transient stream fields only from session node data", () => {
    const nodesToPersist: CanvasNode[] = [
      {
        id: "leader-1",
        type: "leader",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        data: {
          messages: [],
          streamingText: "partial",
          streamingBlockIndex: 0,
          status: "running",
        },
      },
      {
        id: "note-1",
        type: "markdown",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        data: {
          text: "hello",
          streamingText: "kept",
        },
      },
    ];

    expect(toPersistableNodes(nodesToPersist)).toEqual([
      {
        ...nodesToPersist[0],
        data: {
          messages: [],
          status: "running",
        },
      },
      nodesToPersist[1],
    ]);
  });

  it("does not persist canonical lifecycle projections on leader nodes", () => {
    const node: CanvasNode = {
      id: "leader-1", type: "leader", position: { x: 0, y: 0 },
      size: { width: 100, height: 100 }, data: {
        workItemId: "work-1", currentRunKey: "run-1", status: "completed",
        worktreeStatus: "merged", workItemSnapshot: { id: "work-1" }, messages: [],
      },
    };
    expect(toPersistableNodes([node])).toEqual([{ ...node, data: {
      workItemId: "work-1", currentRunKey: "run-1", messages: [],
    } }]);
  });
});
