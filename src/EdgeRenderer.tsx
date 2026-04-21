import { memo, useMemo } from "react";
import type { CanvasNode, CanvasTransform } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import { getContract } from "./graph.ts";

interface EdgeRendererProps {
  graph: GraphDocument;
  nodes: CanvasNode[];
  transform: CanvasTransform;
}

/**
 * Get the position of a port on a node.
 *
 * All ports are visible and rendered as dots. Uses the same spacing math
 * as CanvasNode's port dot rendering: anchorY if specified, otherwise
 * even-spaced among same-direction ports.
 */
function getPortPosition(
  node: CanvasNode,
  portId: string,
  direction: "input" | "output",
): { x: number; y: number } {
  const contract = getContract(node.type);
  if (!contract) {
    return { x: node.position.x, y: node.position.y };
  }

  const port = contract.ports.find((p) => p.id === portId);
  if (!port) {
    return { x: node.position.x, y: node.position.y };
  }

  const sameDirPorts = contract.ports.filter(
    (p) => p.direction === direction,
  );
  const portIndex = sameDirPorts.findIndex((p) => p.id === portId);

  // Use fixed anchorY if specified, otherwise even-space
  const y = port.anchorY != null
    ? node.position.y + node.size.height * port.anchorY
    : node.position.y + node.size.height / (sameDirPorts.length + 1) * (portIndex + 1);

  if (direction === "output") {
    return { x: node.position.x + node.size.width, y };
  }
  return { x: node.position.x, y };
}

const BezierEdge = memo(function BezierEdge({
  x1,
  y1,
  x2,
  y2,
  protocol,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  protocol: string;
}) {
  const dx = Math.abs(x2 - x1) * 0.5;
  const cx1 = x1 + dx;
  const cy1 = y1;
  const cx2 = x2 - dx;
  const cy2 = y2;
  const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;

  const color =
    protocol === "task-assignment"
      ? "var(--accent)"
      : protocol === "task-status"
        ? "var(--edge-status)"
        : protocol === "context"
          ? "var(--edge-context)"
          : "var(--edge-context)";

  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.3}
      />
      {/* Use CSS animation class instead of SVG <animate> element.
          CSS animations are compositor-friendly and can be paused globally
          via prefers-reduced-motion or a parent class. SVG <animate> triggers
          continuous main-thread repaints on every frame. */}
      <path
        className="edge-flow"
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeOpacity={0.8}
        strokeDasharray="6 4"
      />
      {/* Target dot */}
      <circle cx={x2} cy={y2} r={3} fill={color} opacity={0.6} />
      {/* Source dot */}
      <circle cx={x1} cy={y1} r={3} fill={color} opacity={0.6} />
    </>
  );
});

export const EdgeRenderer = memo(function EdgeRenderer({
  graph,
  nodes,
  transform,
}: EdgeRendererProps) {
  if (graph.edges.length === 0) return null;

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <g
        transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}
      >
        {graph.edges.map((edge) => {
          const sourceNode = nodeMap.get(edge.sourceNodeId);
          const targetNode = nodeMap.get(edge.targetNodeId);
          if (!sourceNode || !targetNode) return null;

          const start = getPortPosition(sourceNode, edge.sourcePortId, "output");
          const end = getPortPosition(targetNode, edge.targetPortId, "input");

          return (
            <BezierEdge
              key={edge.id}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              protocol={edge.protocol}
            />
          );
        })}
      </g>
    </svg>
  );
});
