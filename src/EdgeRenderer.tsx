import { memo, useMemo } from "react";
import type { CanvasNode } from "./types.ts";
import type { GraphDocument } from "./graph.ts";
import { getContract } from "./graph.ts";
import {
  computeContextEdgeStaleness,
  type EdgeContextStaleness,
} from "./context-staleness.ts";

interface EdgeRendererProps {
  graph: GraphDocument;
  nodes: CanvasNode[];
  /** ID of the currently selected edge, if any. Highlights that edge and dims the rest. */
  selectedEdgeId?: string | null;
  /** ID of the currently hovered edge, if any. */
  hoveredEdgeId?: string | null;
  /** Called when an edge's hit region is clicked. The event is included so
   *  callers can call stopPropagation / read shift modifiers. */
  onEdgeClick?: (edgeId: string, e: React.MouseEvent) => void;
  /** Called on pointer enter/leave with the edge id (or null on leave). */
  onEdgeHover?: (edgeId: string | null) => void;
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

type ContextBadgeMode = "dashboard" | "lean" | "full";

const CONTEXT_BADGE_LETTER: Record<ContextBadgeMode, string> = {
  dashboard: "D",
  lean: "L",
  full: "F",
};

const CONTEXT_BADGE_TOOLTIP: Record<ContextBadgeMode, string> = {
  dashboard: "Dashboard: forwards this leader's dashboard only (default). Click to change.",
  lean: "Lean: forwards inputs + responses (no thinking/tools). Click to change.",
  full: "Full: forwards inputs + thinking + responses (no tools). Click to change.",
};

interface BezierEdgeProps {
  edgeId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  protocol: string;
  isSelected: boolean;
  isHovered: boolean;
  /** True when *some other* edge is selected — used to fade unrelated edges. */
  isDimmed: boolean;
  /**
   * When set, renders a small mode badge over the target (input) port for
   * leader→leader context edges. Clicking it selects the edge.
   */
  contextBadge?: ContextBadgeMode | undefined;
  staleness?: EdgeContextStaleness | null | undefined;
  onClick?: ((edgeId: string, e: React.MouseEvent) => void) | undefined;
  onHover?: ((edgeId: string | null) => void) | undefined;
}

const BezierEdge = memo(function BezierEdge({
  edgeId,
  x1,
  y1,
  x2,
  y2,
  protocol,
  isSelected,
  isHovered,
  isDimmed,
  contextBadge,
  staleness,
  onClick,
  onHover,
}: BezierEdgeProps) {
  const dx = Math.abs(x2 - x1) * 0.5;
  const cx1 = x1 + dx;
  const cy1 = y1;
  const cx2 = x2 - dx;
  const cy2 = y2;
  const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;

  const edgeColor =
    protocol === "task-assignment"
      ? "var(--accent)"
      : "var(--edge-context)";
  const isStale = staleness?.stale === true;
  const baseColor = isStale ? "var(--warning, #f59e0b)" : edgeColor;

  // Selection/hover modulate stroke weights and opacity.
  // Dimmed edges fade back so the selected one reads as primary.
  const baseStrokeWidth = isSelected ? 3 : 2;
  const flowStrokeWidth = isSelected ? 1.5 : 1;
  const baseOpacity = isStale
    ? isDimmed ? 0.2 : isSelected ? 0.82 : isHovered ? 0.7 : 0.48
    : isDimmed ? 0.12 : isSelected ? 0.7 : isHovered ? 0.55 : 0.3;
  const flowOpacity = isDimmed ? 0.2 : isSelected ? 1 : 0.8;
  const endpointOpacity = isDimmed ? 0.2 : isSelected ? 1 : 0.6;
  const endpointRadius = isSelected ? 4 : 3;

  const interactive = Boolean(onClick || onHover);

  return (
    <g data-edge-id={edgeId}>
      <path
        d={d}
        fill="none"
        stroke={baseColor}
        strokeWidth={baseStrokeWidth}
        strokeOpacity={baseOpacity}
        strokeDasharray={isStale ? "4 4" : undefined}
      />
      {/* Use CSS animation class instead of SVG <animate> element.
          CSS animations are compositor-friendly and can be paused globally
          via prefers-reduced-motion or a parent class. SVG <animate> triggers
          continuous main-thread repaints on every frame. */}
      <path
        className="edge-flow"
        d={d}
        fill="none"
        stroke={edgeColor}
        strokeWidth={flowStrokeWidth}
        strokeOpacity={flowOpacity}
        strokeDasharray="6 4"
      />
      {/* Selection glow circles behind the endpoint dots — give a clear
          visual link from the highlighted edge to its source/target ports
          without requiring CanvasNode to know about edge selection. */}
      {isSelected && (
        <>
          <circle cx={x1} cy={y1} r={8} fill={edgeColor} opacity={0.18} />
          <circle cx={x2} cy={y2} r={8} fill={edgeColor} opacity={0.18} />
        </>
      )}
      <circle cx={x2} cy={y2} r={endpointRadius} fill={edgeColor} opacity={endpointOpacity} />
      <circle cx={x1} cy={y1} r={endpointRadius} fill={edgeColor} opacity={endpointOpacity} />
      {/* Invisible wide hit path on top — gives the edge a comfortable click
          target without changing the visible line weight. The path itself
          opts into stroke-only pointer events so empty fill area inside the
          curve does NOT block underlying canvas interactions. */}
      {interactive && (
        <path
          data-testid={`edge-hit-${edgeId}`}
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          style={{ pointerEvents: "stroke", cursor: "pointer" }}
          onMouseDown={(e) => {
            // Prevent the canvas background mousedown handler (which would
            // start a marquee / clear selection) from firing.
            if (onClick) e.stopPropagation();
          }}
          onClick={(e) => {
            if (onClick) {
              e.stopPropagation();
              onClick(edgeId, e);
            }
          }}
          onMouseEnter={() => onHover?.(edgeId)}
          onMouseLeave={() => onHover?.(null)}
        />
      )}
      {/* Context-mode badge over the target (input) port — leader→leader only.
          Clicking it selects the edge, which opens the EdgeInspector menu. */}
      {contextBadge && (
        <g
          data-testid={`edge-context-badge-${edgeId}`}
          data-stale={isStale ? "true" : undefined}
          transform={`translate(${x2 - 16}, ${y2 - 16})`}
          style={{ pointerEvents: "all", cursor: "pointer" }}
          opacity={isDimmed ? 0.3 : 1}
          onMouseDown={(e) => {
            if (onClick) e.stopPropagation();
          }}
          onClick={(e) => {
            if (onClick) {
              e.stopPropagation();
              onClick(edgeId, e);
            }
          }}
          onMouseEnter={() => onHover?.(edgeId)}
          onMouseLeave={() => onHover?.(null)}
        >
          <title>
            {CONTEXT_BADGE_TOOLTIP[contextBadge]}
            {isStale && staleness?.pendingBlocks != null && staleness.pendingBlocks > 0
              ? ` · ${staleness.pendingBlocks} new ${staleness.pendingBlocks === 1 ? "turn" : "turns"} upstream — delivered with your next message`
              : isStale
                ? " · changed upstream — refreshed with your next message"
                : ""}
            {isStale && staleness?.deliveredAt == null ? " · not yet delivered" : ""}
          </title>
          <circle
            r={9}
            fill="var(--bg-secondary)"
            stroke={edgeColor}
            strokeWidth={isSelected ? 2 : 1.5}
          />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fontWeight={700}
            fill="var(--text-primary)"
            style={{ userSelect: "none", fontFamily: "var(--font-mono)" }}
          >
            {CONTEXT_BADGE_LETTER[contextBadge]}
          </text>
          {isStale && (
            <circle cx={7} cy={-7} r={3} fill="var(--warning, #f59e0b)" />
          )}
        </g>
      )}
    </g>
  );
});

export const EdgeRenderer = memo(function EdgeRenderer({
  graph,
  nodes,
  selectedEdgeId = null,
  hoveredEdgeId = null,
  onEdgeClick,
  onEdgeHover,
}: EdgeRendererProps) {
  // Always create the node map (hooks must be called unconditionally).
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edgeStaleness = useMemo(() => {
    const byEdgeId = new Map<string, EdgeContextStaleness | null>();
    for (const edge of graph.edges) {
      const sourceNode = nodeMap.get(edge.sourceNodeId);
      const targetNode = nodeMap.get(edge.targetNodeId);
      byEdgeId.set(
        edge.id,
        sourceNode && targetNode
          ? computeContextEdgeStaleness(edge, sourceNode, targetNode)
          : null,
      );
    }
    return byEdgeId;
  }, [graph, nodeMap]);
  if (graph.edges.length === 0) return null;

  const hasSelection = selectedEdgeId != null;

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        // The SVG root stays click-through; only the per-edge hit paths
        // re-enable pointer events on their stroke region.
        pointerEvents: "none",
        overflow: "visible",
        zIndex: 0,
      }}
    >
      <g>
        {graph.edges.map((edge) => {
          const sourceNode = nodeMap.get(edge.sourceNodeId);
          const targetNode = nodeMap.get(edge.targetNodeId);
          if (!sourceNode || !targetNode) return null;

          const start = getPortPosition(sourceNode, edge.sourcePortId, "output");
          const end = getPortPosition(targetNode, edge.targetPortId, "input");

          const isSelected = selectedEdgeId === edge.id;
          const isHovered = hoveredEdgeId === edge.id;
          const isDimmed = hasSelection && !isSelected;

          // Leader→leader context edges carry a forwarding-mode badge.
          const contextBadge =
            edge.protocol === "context" &&
            sourceNode.type === "leader" &&
            targetNode.type === "leader"
              ? ((edge.contextMode ?? "dashboard") as ContextBadgeMode)
              : undefined;

          return (
            <BezierEdge
              key={edge.id}
              edgeId={edge.id}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              protocol={edge.protocol}
              isSelected={isSelected}
              isHovered={isHovered}
              isDimmed={isDimmed}
              contextBadge={contextBadge}
              staleness={edgeStaleness.get(edge.id)}
              onClick={onEdgeClick}
              onHover={onEdgeHover}
            />
          );
        })}
      </g>
    </svg>
  );
});
