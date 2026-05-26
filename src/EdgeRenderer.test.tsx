/**
 * EdgeRenderer — behaviour tests for interactive persistent edges.
 *
 * Verifies the new edge-selection contract:
 *   - Edges expose a wide invisible hit path that fires onEdgeClick.
 *   - Hover enter/leave round-trip through onEdgeHover.
 *   - When an edge is selected, unrelated edges visually dim.
 *   - Selected edges paint selection-glow circles at their endpoints.
 *   - Empty graphs render nothing.
 *   - Hit path stays out of the DOM when no handlers are wired (so the
 *     SVG stays click-through for the rest of the canvas).
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EdgeRenderer } from "./EdgeRenderer.tsx";
import type { CanvasNode } from "./types.ts";
import type { GraphDocument } from "./graph.ts";

const NODES: CanvasNode[] = [
  {
    id: "leader-1",
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    data: { sessionKey: null },
  },
  {
    id: "minion-1",
    type: "minion",
    position: { x: 400, y: 0 },
    size: { width: 200, height: 100 },
    data: {},
  },
  {
    id: "minion-2",
    type: "minion",
    position: { x: 400, y: 200 },
    size: { width: 200, height: 100 },
    data: {},
  },
];

const TWO_EDGE_GRAPH: GraphDocument = {
  edges: [
    {
      id: "edge-a",
      sourceNodeId: "leader-1",
      sourcePortId: "task-out",
      targetNodeId: "minion-1",
      targetPortId: "task-in",
      protocol: "task-assignment",
    },
    {
      id: "edge-b",
      sourceNodeId: "leader-1",
      sourcePortId: "task-out",
      targetNodeId: "minion-2",
      targetPortId: "task-in",
      protocol: "task-assignment",
    },
  ],
};

function renderInSvg(ui: React.ReactNode) {
  // EdgeRenderer is its own <svg>; we render it directly inside a container.
  return render(<div>{ui}</div>);
}

describe("EdgeRenderer interactivity", () => {
  it("renders nothing when the graph has no edges", () => {
    const { container } = renderInSvg(
      <EdgeRenderer graph={{ edges: [] }} nodes={NODES} />,
    );
    // No <svg> emitted when there are no edges to draw.
    expect(container.querySelector("svg")).toBeNull();
  });

  it("omits the invisible hit path when no interaction callbacks are wired", () => {
    const { container } = renderInSvg(
      <EdgeRenderer graph={TWO_EDGE_GRAPH} nodes={NODES} />,
    );
    // No hit path → SVG stays click-through (root pointerEvents: none).
    expect(container.querySelector('[data-testid="edge-hit-edge-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="edge-hit-edge-b"]')).toBeNull();
  });

  it("invokes onEdgeClick when the hit path is clicked", () => {
    const onEdgeClick = vi.fn();
    const { getByTestId } = renderInSvg(
      <EdgeRenderer
        graph={TWO_EDGE_GRAPH}
        nodes={NODES}
        onEdgeClick={onEdgeClick}
      />,
    );
    fireEvent.click(getByTestId("edge-hit-edge-a"));
    expect(onEdgeClick).toHaveBeenCalledTimes(1);
    expect(onEdgeClick.mock.calls[0]?.[0]).toBe("edge-a");
  });

  it("fires onEdgeHover with edge id on enter and null on leave", () => {
    const onEdgeHover = vi.fn();
    const { getByTestId } = renderInSvg(
      <EdgeRenderer
        graph={TWO_EDGE_GRAPH}
        nodes={NODES}
        onEdgeHover={onEdgeHover}
      />,
    );
    fireEvent.mouseEnter(getByTestId("edge-hit-edge-b"));
    fireEvent.mouseLeave(getByTestId("edge-hit-edge-b"));
    expect(onEdgeHover).toHaveBeenNthCalledWith(1, "edge-b");
    expect(onEdgeHover).toHaveBeenNthCalledWith(2, null);
  });

  it("stops propagation on click so the canvas background does not clear selection", () => {
    const onEdgeClick = vi.fn();
    const containerClick = vi.fn();
    const { getByTestId } = render(
      <div onClick={containerClick}>
        <EdgeRenderer
          graph={TWO_EDGE_GRAPH}
          nodes={NODES}
          onEdgeClick={onEdgeClick}
        />
      </div>,
    );
    fireEvent.click(getByTestId("edge-hit-edge-a"));
    expect(onEdgeClick).toHaveBeenCalled();
    expect(containerClick).not.toHaveBeenCalled();
  });

  it("paints a selection halo at both endpoints of the selected edge", () => {
    const { container } = renderInSvg(
      <EdgeRenderer
        graph={TWO_EDGE_GRAPH}
        nodes={NODES}
        selectedEdgeId="edge-a"
        onEdgeClick={() => {}}
      />,
    );
    // Each selected edge adds two halo circles (r=8) on top of two endpoint
    // dots. With one selected edge + one unselected, total circles = 2 (halo)
    // + 2 (selected dots) + 2 (unselected dots) = 6.
    const haloCircles = container.querySelectorAll('circle[r="8"]');
    expect(haloCircles.length).toBe(2);
  });

  it("dims unrelated edges when one is selected", () => {
    const { container } = renderInSvg(
      <EdgeRenderer
        graph={TWO_EDGE_GRAPH}
        nodes={NODES}
        selectedEdgeId="edge-a"
        onEdgeClick={() => {}}
      />,
    );
    const groups = container.querySelectorAll("g[data-edge-id]");
    const byId = new Map<string, Element>();
    for (const g of Array.from(groups)) {
      byId.set(g.getAttribute("data-edge-id")!, g);
    }
    const selectedFlow = byId.get("edge-a")?.querySelector("path.edge-flow");
    const dimmedFlow = byId.get("edge-b")?.querySelector("path.edge-flow");
    expect(selectedFlow?.getAttribute("stroke-opacity")).toBe("1");
    // Dimmed flow opacity (0.2) is strictly lower than selected (1.0).
    const dimmedOpacity = parseFloat(
      dimmedFlow?.getAttribute("stroke-opacity") ?? "1",
    );
    expect(dimmedOpacity).toBeLessThan(0.5);
  });

  it("skips edges that reference missing nodes", () => {
    const danglingGraph: GraphDocument = {
      edges: [
        {
          id: "edge-orphan",
          sourceNodeId: "leader-1",
          sourcePortId: "task-out",
          targetNodeId: "minion-does-not-exist",
          targetPortId: "task-in",
          protocol: "task-assignment",
        },
      ],
    };
    const { container } = renderInSvg(
      <EdgeRenderer
        graph={danglingGraph}
        nodes={NODES}
        onEdgeClick={() => {}}
      />,
    );
    // No edge group emitted for the orphan.
    expect(container.querySelector("g[data-edge-id]")).toBeNull();
  });
});
