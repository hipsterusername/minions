import type { CanvasNode, CanvasTransform } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import { getContract } from "./graph.ts";

interface EdgeRendererProps {
  graph: GraphDocument;
  nodes: CanvasNode[];
  transform: CanvasTransform;
}

function getPortPosition(
  node: CanvasNode,
  portId: string,
  direction: "input" | "output",
): { x: number; y: number } {
  const contract = getContract(node.type);
  if (!contract) {
    return { x: node.position.x, y: node.position.y };
  }

  const ports = contract.ports.filter((p) => p.direction === direction);
  const portIndex = ports.findIndex((p) => p.id === portId);
  const spacing = node.size.height / (ports.length + 1);
  const y = node.position.y + spacing * (portIndex + 1);

  if (direction === "output") {
    return { x: node.position.x + node.size.width, y };
  }
  return { x: node.position.x, y };
}

function BezierEdge({
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
      ? "#818cf8"
      : protocol === "task-status"
        ? "#facc15"
        : "#4ade80";

  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.3}
      />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeOpacity={0.8}
        strokeDasharray="6 4"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="20"
          to="0"
          dur="1s"
          repeatCount="indefinite"
        />
      </path>
      {/* Target dot */}
      <circle cx={x2} cy={y2} r={3} fill={color} opacity={0.6} />
      {/* Source dot */}
      <circle cx={x1} cy={y1} r={3} fill={color} opacity={0.6} />
    </>
  );
}

export function EdgeRenderer({
  graph,
  nodes,
  transform,
}: EdgeRendererProps) {
  if (graph.edges.length === 0) return null;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

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
}
