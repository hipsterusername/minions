/**
 * Auto-layout for the canvas.
 *
 * Arranges nodes into a clean visual structure based on their roles
 * and connections:
 *
 *   - Leader nodes are anchor points.  Their context providers sit in a
 *     row above them; their minions fan out in a row below.
 *   - Multiple leader clusters are packed left-to-right, wrapping when
 *     the row exceeds MAX_ROW_WIDTH.
 *   - Unconnected (isolate) nodes are arranged below the cluster region
 *     in a horizontal flow.
 *   - Context-group containment is spatial in this codebase — contained
 *     nodes are moved by the same delta as their group so membership
 *     is preserved after layout.
 *
 * Returns `Array<{ id, position }>` ready for:
 *   dispatch({ type: 'MOVE_GROUP', moves })
 */

import type { CanvasNode, Position } from "./types.ts";
import type { GraphEdge } from "./graph.ts";

// ── Layout constants ─────────────────────────────────────────────

/** Gap between sibling nodes in the same row (context row or minion row). */
const NODE_GAP = 40;

/** Vertical clearance between context row bottom and leader top. */
const CONTEXT_GAP = 60;

/** Vertical clearance between leader bottom and minion row top. */
const MINION_GAP = 60;

/** Space between adjacent cluster bounding boxes. */
const CLUSTER_GAP = 100;

/** Extra vertical space separating clusters from the isolate region. */
const ISOLATE_GAP = 120;

/** Max width of a cluster pack row before wrapping (world units). */
const MAX_ROW_WIDTH = 2400;

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Mirrors `isInsideGroup` from Canvas.tsx (GROUP_HEADER = 36).
 * Uses the top-centre of the candidate node rather than its geometric
 * centre so that tall nodes are still detected even when the group
 * frame hasn't auto-resized to fit them yet.
 */
const GROUP_HEADER = 36;
function isInsideGroup(node: CanvasNode, group: CanvasNode): boolean {
  const cx = node.position.x + node.size.width / 2;
  const cy = node.position.y + Math.min(node.size.height / 2, GROUP_HEADER);
  return (
    cx >= group.position.x &&
    cx <= group.position.x + group.size.width &&
    cy >= group.position.y &&
    cy <= group.position.y + group.size.height
  );
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned bounding rect of a set of (size, position) pairs. */
function boundingRect(
  entries: Array<{ size: { width: number; height: number }; pos: Position }>,
): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const { size, pos } of entries) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + size.width);
    maxY = Math.max(maxY, pos.y + size.height);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── Public API ───────────────────────────────────────────────────

export interface AutoLayoutOptions {
  /**
   * World-space point to centre the overall layout around.
   * Defaults to the centroid of the current node positions.
   */
  center?: Position;
}

/**
 * Compute new positions for all nodes on the canvas.
 *
 * The function is pure — it reads `nodes` and `edges` and returns a
 * list of moves without mutating anything or touching the DOM.
 */
export function computeAutoLayout(
  nodes: CanvasNode[],
  edges: GraphEdge[],
  options: AutoLayoutOptions = {},
): Array<{ id: string; position: Position }> {
  if (nodes.length === 0) return [];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // ── Phase 0: Snapshot context-group membership ───────────────
  // Containment is determined at runtime by position overlap.
  // Capture membership *before* any positions change so we can
  // propagate group deltas to children in Phase 5.
  const memberMap = new Map<string, string[]>(); // groupId → childIds
  const insideGroupIds = new Set<string>();

  for (const n of nodes) {
    if (n.type !== "context-group") continue;
    const members = nodes.filter((m) => m.id !== n.id && isInsideGroup(m, n));
    memberMap.set(n.id, members.map((m) => m.id));
    for (const m of members) insideGroupIds.add(m.id);
  }

  // ── Phase 1: Build leader clusters ──────────────────────────
  // Each leader claims its minions (task-assignment out-edges) and
  // context providers (context in-edges).  First-come-first-served
  // deduplication prevents a shared context node from appearing in
  // two clusters simultaneously.
  const assignedIds = new Set<string>();

  interface Cluster {
    leader: CanvasNode;
    minions: CanvasNode[];
    contextNodes: CanvasNode[];
  }

  const clusters: Cluster[] = [];

  for (const node of nodes) {
    if (node.type !== "leader") continue;

    const minions = edges
      .filter(
        (e) =>
          e.sourceNodeId === node.id && e.protocol === "task-assignment",
      )
      .map((e) => nodeMap.get(e.targetNodeId))
      .filter((n): n is CanvasNode => !!n && !assignedIds.has(n.id));

    const contextNodes = edges
      .filter(
        (e) => e.targetNodeId === node.id && e.protocol === "context",
      )
      .map((e) => nodeMap.get(e.sourceNodeId))
      .filter((n): n is CanvasNode => !!n && !assignedIds.has(n.id));

    assignedIds.add(node.id);
    for (const m of minions) assignedIds.add(m.id);
    for (const c of contextNodes) assignedIds.add(c.id);

    clusters.push({ leader: node, minions, contextNodes });
  }

  // ── Phase 2: Intra-cluster layout ────────────────────────────
  // Positions are computed relative to (0, 0); the cluster top-left
  // is normalised to the origin before packing.
  interface ClusterLayout {
    positions: Map<string, Position>;
    rect: Rect;
  }

  function layoutCluster(c: Cluster): ClusterLayout {
    const pos = new Map<string, Position>();
    const { leader, minions, contextNodes } = c;

    // Tallest context node determines the context row height.
    const ctxRowH =
      contextNodes.length > 0
        ? Math.max(...contextNodes.map((n) => n.size.height))
        : 0;

    // Leader sits below the context row (or at the top if none).
    const leaderY = ctxRowH > 0 ? ctxRowH + CONTEXT_GAP : 0;
    pos.set(leader.id, { x: 0, y: leaderY });

    // Context nodes: centred horizontally above the leader.
    if (contextNodes.length > 0) {
      const totalW =
        contextNodes.reduce((s, n) => s + n.size.width, 0) +
        NODE_GAP * (contextNodes.length - 1);
      let cx = leader.size.width / 2 - totalW / 2;
      for (const cp of contextNodes) {
        pos.set(cp.id, { x: cx, y: 0 });
        cx += cp.size.width + NODE_GAP;
      }
    }

    // Minions: centred horizontally below the leader.
    if (minions.length > 0) {
      const totalW =
        minions.reduce((s, n) => s + n.size.width, 0) +
        NODE_GAP * (minions.length - 1);
      let mx = leader.size.width / 2 - totalW / 2;
      const my = leaderY + leader.size.height + MINION_GAP;
      for (const m of minions) {
        pos.set(m.id, { x: mx, y: my });
        mx += m.size.width + NODE_GAP;
      }
    }

    // Bounding rect; normalise so top-left is exactly (0, 0).
    const entries = [...pos.entries()].map(([id, p]) => ({
      size: nodeMap.get(id)!.size,
      pos: p,
    }));
    const r = boundingRect(entries);
    if (r.x !== 0 || r.y !== 0) {
      for (const [id, p] of pos) {
        pos.set(id, { x: p.x - r.x, y: p.y - r.y });
      }
    }

    return { positions: pos, rect: { x: 0, y: 0, w: r.w, h: r.h } };
  }

  const clusterLayouts = clusters.map((c) => ({
    cluster: c,
    ...layoutCluster(c),
  }));

  // ── Phase 3: Determine layout origin ─────────────────────────
  // Centre the entire pack on the requested point, falling back to
  // the centroid of all current node positions.
  const centre = options.center ?? {
    x:
      nodes.reduce((s, n) => s + n.position.x + n.size.width / 2, 0) /
      nodes.length,
    y:
      nodes.reduce((s, n) => s + n.position.y + n.size.height / 2, 0) /
      nodes.length,
  };

  const totalClusterW =
    clusterLayouts.reduce((s, { rect }) => s + rect.w, 0) +
    CLUSTER_GAP * Math.max(0, clusterLayouts.length - 1);
  const totalClusterH = clusterLayouts.reduce(
    (s, { rect }) => Math.max(s, rect.h),
    0,
  );

  const originX = centre.x - totalClusterW / 2;
  const originY = centre.y - totalClusterH / 2;

  // ── Phase 4: Pack clusters left-to-right ─────────────────────
  const finalPositions = new Map<string, Position>();
  let curX = originX;
  let curY = originY;
  let rowH = 0;

  for (const { positions, rect } of clusterLayouts) {
    // Wrap to a new row when this cluster would exceed max width.
    if (curX + rect.w > originX + MAX_ROW_WIDTH && curX > originX) {
      curX = originX;
      curY += rowH + CLUSTER_GAP;
      rowH = 0;
    }
    for (const [id, p] of positions) {
      finalPositions.set(id, {
        x: Math.round(curX + p.x),
        y: Math.round(curY + p.y),
      });
    }
    curX += rect.w + CLUSTER_GAP;
    rowH = Math.max(rowH, rect.h);
  }

  // ── Phase 5: Place isolates ──────────────────────────────────
  // Nodes not owned by any cluster and not inside a context-group.
  const isolates = nodes.filter(
    (n) => !assignedIds.has(n.id) && !insideGroupIds.has(n.id),
  );

  if (isolates.length > 0) {
    let ix = originX;
    let iy =
      originY +
      (clusterLayouts.length > 0 ? totalClusterH + ISOLATE_GAP : 0);
    let iRowH = 0;

    for (const n of isolates) {
      if (ix + n.size.width > originX + MAX_ROW_WIDTH && ix > originX) {
        ix = originX;
        iy += iRowH + NODE_GAP;
        iRowH = 0;
      }
      finalPositions.set(n.id, { x: Math.round(ix), y: Math.round(iy) });
      ix += n.size.width + NODE_GAP;
      iRowH = Math.max(iRowH, n.size.height);
    }
  }

  // ── Phase 6: Propagate context-group → member deltas ─────────
  // Contained nodes move by the same vector as their group so the
  // spatial membership check continues to hold after layout.
  for (const [groupId, memberIds] of memberMap) {
    const group = nodeMap.get(groupId)!;
    const newGroupPos = finalPositions.get(groupId);
    if (!newGroupPos) continue;
    const dx = newGroupPos.x - group.position.x;
    const dy = newGroupPos.y - group.position.y;
    for (const memberId of memberIds) {
      const member = nodeMap.get(memberId)!;
      finalPositions.set(memberId, {
        x: Math.round(member.position.x + dx),
        y: Math.round(member.position.y + dy),
      });
    }
  }

  // Build the final moves array.
  return [...finalPositions.entries()].map(([id, position]) => ({
    id,
    position,
  }));
}
