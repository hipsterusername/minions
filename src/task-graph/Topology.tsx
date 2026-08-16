import { useId, useMemo } from "react";
import { nodeIdsForPlanItem, projectTopology, runtimeRole, whyNotRunning } from "./model.ts";
import { NodeState } from "./NodeState.tsx";
import type { GraphFilter, GraphPlanItem, TaskGraphEdgeView, TaskGraphNodeView, TaskGraphSnapshotView } from "./types.ts";

const NODE_WIDTH = 176;
const NODE_HEIGHT = 84;
const COLUMN_GAP = 78;
const ROW_GAP = 22;
const ROOT_WIDTH = 150;
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
  const markerId = useId().replaceAll(":", "");
  const projection = useMemo(
    () => projectTopology(snapshot, filter, selectedNodeId),
    [snapshot, filter, selectedNodeId],
  );
  const visibleIds = useMemo(() => new Set(projection.nodes.map((node) => node.id)), [projection.nodes]);
  const layoutEdges = useMemo(
    () => snapshot.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [snapshot.edges, visibleIds],
  );
  const layout = useMemo(() => layoutDag(projection.nodes, layoutEdges), [projection.nodes, layoutEdges]);
  const focusedPlan = plan.find((item) => item.taskId === focusedPlanTaskId);
  const focusedIds = nodeIdsForPlanItem(snapshot.nodes, focusedPlan);
  const hasPlanFocus = focusedIds.size > 0;
  const selectedEdges = new Set(
    projection.edges
      .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
      .map((edge) => edge.id),
  );
  const rootTargets = layout.positioned.filter(({ node }) => !layoutEdges.some((edge) => edge.target === node.id));
  const rootY = Math.max(PADDING_Y, (layout.height - NODE_HEIGHT) / 2);

  return (
    <div className="tg-flow" aria-label="Relational task graph flow">
      <div className="tg-topology__notice">
        <span>Showing {projection.nodes.length} logical nodes and {projection.edges.length} visible edges.</span>
        {projection.hiddenNodeCount > 0 ? <span>{projection.hiddenNodeCount} nodes aggregated.</span> : null}
        {projection.hiddenEdgeCount > 0 ? <span>{projection.hiddenEdgeCount} edges hidden until focus.</span> : null}
        {focusedPlanTaskId && !hasPlanFocus ? <span className="tg-notice-attention">Selected plan item has no exact runtime projection.</span> : null}
      </div>
      <div className="tg-flow-scroll">
        <div className="tg-flow-canvas" style={{ width: layout.width, height: layout.height }}>
          <svg className="tg-flow-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
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

          <article className="tg-flow-root" style={{ left: PADDING_X, top: rootY }}>
            <span className="tg-role-label">Leader · graph run</span>
            <strong>{snapshot.title}</strong>
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
                <strong>{node.title}</strong>
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
      <div className="tg-flow-hint"><kbd>Click</kbd> inspect · <kbd>Plan</kbd> focus mapping · ordinary edges collapse at scale</div>
    </div>
  );
}

export function layoutDag(nodes: readonly TaskGraphNodeView[], edges: readonly TaskGraphEdgeView[]) {
  const visibleIds = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

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
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const width = Math.max(900, PADDING_X * 2 + ROOT_WIDTH + ROOT_GAP + columns.size * NODE_WIDTH + Math.max(0, columns.size - 1) * COLUMN_GAP);
  const height = Math.max(520, PADDING_Y * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP);
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
