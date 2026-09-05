import { useId, useMemo, useRef } from "react";
import { useTopologyCamera } from "./use-topology-camera.ts";
export { fitTopologyCamera } from "./use-topology-camera.ts";
import { nodeIdsForPlanItem, projectTopology, runtimeRole, whyNotRunning } from "./model.ts";
import { NodeState } from "./NodeState.tsx";
import type { GraphFilter, GraphPlanItem, TaskGraphEdgeView, TaskGraphNodeView, TaskGraphSnapshotView } from "./types.ts";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 112;
const COLUMN_GAP = 78;
const ROW_GAP = 32;
const ROOT_WIDTH = 200;
const ROOT_GAP = 76;
const PADDING_X = 32;
const PADDING_Y = 52;
interface PositionedNode {
  node: TaskGraphNodeView;
  x: number;
  y: number;
}

export function Topology({
  snapshot,
  filter,
  selectedNodeId,
  focusedPlanTaskId = null,
  plan = [],
  onSelect,
}: {
  snapshot: TaskGraphSnapshotView;
  filter: GraphFilter;
  selectedNodeId: string | null;
  focusedPlanTaskId?: string | null;
  plan?: readonly GraphPlanItem[];
  onSelect: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const markerId = useId().replaceAll(":", "");
  const projection = useMemo(
    () => projectTopology(snapshot, filter, selectedNodeId),
    [snapshot, filter, selectedNodeId],
  );
  const layout = useMemo(
    () => layoutDag(projection.nodes, projection.edges),
    [projection.nodes, projection.edges],
  );
  const { camera, zoom, setZoom, zoomBy } = useTopologyCamera(scrollRef, layout);
  const focusedPlan = plan.find((item) => item.taskId === focusedPlanTaskId);
  const focusedIds = nodeIdsForPlanItem(snapshot.nodes, focusedPlan);
  const hasPlanFocus = focusedIds.size > 0;
  const selectedEdges = new Set(
    projection.edges
      .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
      .map((edge) => edge.id),
  );
  const rootTargets = layout.positioned.filter(({ node }) => !projection.edges.some((edge) => edge.target === node.id));
  const rootY = Math.max(PADDING_Y, (layout.height - NODE_HEIGHT) / 2);

  return (
    <div className="tg-flow" aria-label="Relational task graph flow">
      <div className="tg-topology__notice">
        <span>Showing {projection.nodes.length} logical nodes and {projection.edges.length} visible edges.</span>
        {projection.hiddenNodeCount > 0 ? <span>{projection.hiddenNodeCount} nodes aggregated.</span> : null}
        {projection.hiddenEdgeCount > 0 ? <span>{projection.hiddenEdgeCount} edges hidden until focus.</span> : null}
        {focusedPlanTaskId && !hasPlanFocus ? <span className="tg-notice-attention">Selected plan item has no exact runtime projection.</span> : null}
      </div>
      <div className="tg-flow-controls" role="group" aria-label="Graph zoom controls">
        <button type="button" className="tg-button" aria-label="Zoom out" disabled={camera.scale <= 0.1} onClick={() => zoomBy(-0.2)}>−</button>
        <button type="button" className="tg-button" aria-label="Reset graph zoom to 100%" onClick={() => setZoom(1)}>{Math.round(camera.scale * 100)}%</button>
        <button type="button" className="tg-button" aria-label="Zoom in" disabled={camera.scale >= 2} onClick={() => zoomBy(0.2)}>+</button>
        <button type="button" className="tg-button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>Fit graph</button>
      </div>
      <div ref={scrollRef} className="tg-flow-scroll" tabIndex={0} role="region" aria-label="Graph canvas"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType === "touch" || (event.target as Element).closest("button")) return;
          const element = event.currentTarget;
          drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
          element.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { drag.current = null; }}
      >
        <div
          className="tg-flow-canvas"
          style={{ width: camera.stageWidth, height: camera.stageHeight }}
        >
          <div
            className="tg-flow-scene"
            data-camera-offset-x={camera.offsetX}
            data-camera-offset-y={camera.offsetY}
            data-camera-scale={camera.scale}
            data-scene-width={layout.width}
            data-scene-height={layout.height}
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${camera.offsetX}px, ${camera.offsetY}px) scale(${camera.scale})`,
            }}
          >
            <svg
              className="tg-flow-layer tg-flow-layer--edges tg-flow-edges"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker id={`tg-arrow-${markerId}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L8,4 L0,8 z" />
                </marker>
              </defs>
              {rootTargets.map(({ node, x, y }) => (
                <path
                  className="tg-flow-edge tg-flow-edge--expansion"
                  key={`root-${node.id}`}
                  d={edgePath(PADDING_X + ROOT_WIDTH, rootY + NODE_HEIGHT / 2, x, y + NODE_HEIGHT / 2)}
                  markerEnd={`url(#tg-arrow-${markerId})`}
                />
              ))}
              {projection.edges.map((edge) => {
                const source = layout.byId.get(edge.source);
                const target = layout.byId.get(edge.target);
                if (!source || !target) return null;
                const related = selectedEdges.has(edge.id);
                const dimmed = hasPlanFocus && !focusedIds.has(edge.source) && !focusedIds.has(edge.target);
                return (
                  <path
                    key={edge.id}
                    className={`tg-flow-edge tg-flow-edge--${edge.type} tg-flow-edge--${edge.state}${related ? " is-related" : ""}${dimmed ? " is-dimmed" : ""}`}
                    d={edgePath(source.x + NODE_WIDTH, source.y + NODE_HEIGHT / 2, target.x, target.y + NODE_HEIGHT / 2)}
                    markerEnd={`url(#tg-arrow-${markerId})`}
                  >
                    <title>{edge.source} to {edge.target}: {edge.type}</title>
                  </path>
                );
              })}
            </svg>

            <div className="tg-flow-layer tg-flow-layer--nodes">
              <article className="tg-flow-root" style={{ left: PADDING_X, top: rootY }}>
                <span className="tg-role-label">Leader · graph run</span>
                <strong title={snapshot.title}>{snapshot.title}</strong>
                <small>rev {snapshot.revision} · {snapshot.status}</small>
              </article>

              {layout.positioned.map(({ node, x, y }) => {
                const role = runtimeRole(node, plan);
                const mappedPlanIndex = plan.findIndex((item) => item.taskId === node.id || (!!item.minionSessionKey && item.minionSessionKey === node.currentAttempt?.sessionId));
                const selected = selectedNodeId === node.id;
                const related = selectedEdges.size > 0 && projection.edges.some((edge) => selectedEdges.has(edge.id) && (edge.source === node.id || edge.target === node.id));
                const dimmed = hasPlanFocus && !focusedIds.has(node.id);
                return (
                  <button
                    type="button"
                    key={node.id}
                    className={`tg-flow-node tg-flow-node--${role}${selected ? " is-selected" : ""}${related ? " is-related" : ""}${dimmed ? " is-dimmed" : ""}`}
                    style={{ left: x, top: y }}
                    aria-label={`${roleLabel(role)} ${node.title}; logical ${node.logicalState}; ${whyNotRunning(node)}`}
                    onClick={() => onSelect(node.id)}
                  >
                    <span className="tg-flow-node__top">
                      <span className="tg-role-label"><i />{roleLabel(role)}</span>
                      {mappedPlanIndex >= 0 ? <span className="tg-plan-badge">P{mappedPlanIndex + 1}</span> : null}
                    </span>
                    <strong title={node.title}>{node.title}</strong>
                    <span className="tg-flow-node__meta">
                      <NodeState node={node} compact />
                      <span>{node.currentAttempt?.state ?? node.readiness}</span>
                      <span>${node.costUsd.toFixed(2)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="tg-flow-hint">Drag or scroll to pan · Select a task to inspect</div>
    </div>
  );
}

export function layoutDag(nodes: readonly TaskGraphNodeView[], edges: readonly TaskGraphEdgeView[]) {
  const visibleIds = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const incoming = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
    incoming.get(edge.target)?.push(edge.source);
  }
  for (const adjacent of [...outgoing.values(), ...incoming.values()]) adjacent.sort();

  const depth = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).toSorted(nodeOrder).map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }

  // A canonical graph is acyclic. If a stale or partial projection contains a
  // cycle, keep those nodes visible in a stable final column rather than
  // looping or fabricating topology.
  const fallbackDepth = Math.max(0, ...depth.values());
  for (const node of nodes) if (!visited.has(node.id)) depth.set(node.id, fallbackDepth + 1);

  const columns = new Map<number, TaskGraphNodeView[]>();
  for (const node of nodes.toSorted(nodeOrder)) {
    const column = depth.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  reduceCrossings(columns, incoming, outgoing);
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const columnCount = Math.max(0, ...columns.keys()) + 1;
  const width = Math.max(1, PADDING_X * 2 + ROOT_WIDTH + ROOT_GAP + columnCount * NODE_WIDTH + Math.max(0, columnCount - 1) * COLUMN_GAP);
  const height = Math.max(1, PADDING_Y * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP);
  const positioned: PositionedNode[] = [];
  for (const [columnIndex, columnNodes] of [...columns].toSorted(([a], [b]) => a - b)) {
    const columnHeight = columnNodes.length * NODE_HEIGHT + Math.max(0, columnNodes.length - 1) * ROW_GAP;
    const yStart = Math.max(PADDING_Y, (height - columnHeight) / 2);
    columnNodes.forEach((node, rowIndex) => positioned.push({
      node,
      x: PADDING_X + ROOT_WIDTH + ROOT_GAP + columnIndex * (NODE_WIDTH + COLUMN_GAP),
      y: yStart + rowIndex * (NODE_HEIGHT + ROW_GAP),
    }));
  }
  return { positioned, byId: new Map(positioned.map((item) => [item.node.id, item])), width, height };
}

function reduceCrossings(
  columns: Map<number, TaskGraphNodeView[]>,
  incoming: ReadonlyMap<string, readonly string[]>,
  outgoing: ReadonlyMap<string, readonly string[]>,
) {
  const columnIndexes = [...columns.keys()].toSorted((left, right) => left - right);
  for (let pass = 0; pass < 4; pass += 1) {
    for (const columnIndex of columnIndexes.slice(1)) {
      sortByAdjacentBarycenter(columns, columnIndex, incoming);
    }
    for (const columnIndex of columnIndexes.slice(0, -1).reverse()) {
      sortByAdjacentBarycenter(columns, columnIndex, outgoing);
    }
  }
}

function sortByAdjacentBarycenter(
  columns: Map<number, TaskGraphNodeView[]>,
  columnIndex: number,
  adjacent: ReadonlyMap<string, readonly string[]>,
) {
  const column = columns.get(columnIndex);
  if (!column || column.length < 2) return;
  const ranks = new Map<string, number>();
  for (const nodes of columns.values()) {
    nodes.forEach((node, index) => ranks.set(node.id, index));
  }
  const barycenter = (node: TaskGraphNodeView) => {
    const adjacentRanks = (adjacent.get(node.id) ?? [])
      .map((id) => ranks.get(id))
      .filter((rank): rank is number => rank != null);
    return adjacentRanks.length
      ? adjacentRanks.reduce((sum, rank) => sum + rank, 0) / adjacentRanks.length
      : null;
  };
  const previousRank = new Map(column.map((node, index) => [node.id, index]));
  column.sort((left, right) => {
    const leftBarycenter = barycenter(left);
    const rightBarycenter = barycenter(right);
    if (leftBarycenter != null && rightBarycenter != null && leftBarycenter !== rightBarycenter) {
      return leftBarycenter - rightBarycenter;
    }
    if (leftBarycenter != null && rightBarycenter == null) return -1;
    if (leftBarycenter == null && rightBarycenter != null) return 1;
    return (previousRank.get(left.id) ?? 0) - (previousRank.get(right.id) ?? 0) || nodeOrder(left, right);
  });
}

function nodeOrder(left: TaskGraphNodeView, right: TaskGraphNodeView) {
  return Number(right.criticalPath) - Number(left.criticalPath) || right.priority - left.priority || left.id.localeCompare(right.id);
}

function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const control = Math.max(34, Math.abs(x2 - x1) * 0.46);
  return `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`;
}

function roleLabel(role: ReturnType<typeof runtimeRole>) {
  switch (role) {
    case "leader": return "Leader work";
    case "minion": return "Minion";
    case "checkpoint": return "Join";
    case "outcome": return "Outcome";
    case "task": return "Task";
  }
}
