/**
 * Auto-layout for the canvas.
 *
 * Arranges nodes into a clean visual structure based on their roles
 * and connections:
 *
 *   - Leader nodes are anchor points.  Their context providers sit in a
 *     row above them; their child nodes (minions, dashboards) fan out
 *     in a column to the right.
 *   - Chained leaders (where leader A's dashboard feeds leader B's
 *     context-in port via a context edge) are kept together as one
 *     connected unit in producer-first order so the data-flow reads
 *     left-to-right.
 *   - Every workstream unit — a lone leader cluster or a multi-cluster
 *     chain — participates in a single horizontal row flow, packed
 *     left-to-right and ordered by last update date (running agents
 *     treated as most recent) so a unit's place in the row reflects the
 *     most recently updated node it contains.  A connected unit's
 *     clusters stay contiguous; the flow wraps to a new row only when
 *     appending the next unit would exceed MAX_ROW_WIDTH.  Each cluster's
 *     bounding box includes its right-side children so the next cluster
 *     avoids overlap.
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

/** Horizontal clearance between leader right edge and child column left edge. */
const CHILD_GAP_X = 40;

/** Space between adjacent cluster bounding boxes. */
const CLUSTER_GAP = 100;

/** Extra vertical space separating clusters from the isolate region. */
const ISOLATE_GAP = 120;

/** Max width of a cluster pack row before wrapping (world units). */
const MAX_ROW_WIDTH = 2400;

// ── Internal helpers ─────────────────────────────────────────────

const RUNNING_AGENT_STATUSES = new Set(["creating", "running", "starting"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function latestTimestampFromArray(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let latest = 0;
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const direct =
      timestampValue(rec["timestamp"]) ??
      timestampValue(rec["updatedAt"]) ??
      timestampValue(rec["updated_at"]) ??
      timestampValue(rec["lastUpdatedAt"]) ??
      timestampValue(rec["last_updated_at"]) ??
      timestampValue(rec["lastActivityAt"]) ??
      timestampValue(rec["last_activity_at"]) ??
      timestampValue(rec["completedAt"]) ??
      timestampValue(rec["completed_at"]) ??
      timestampValue(rec["createdAt"]) ??
      timestampValue(rec["created_at"]);
    if (direct != null) latest = Math.max(latest, direct);
  }
  return latest;
}

function nodeLastUpdatedAt(node: CanvasNode): number {
  const data = asRecord(node.data);
  if (!data) return 0;

  const directCandidates = [
    data["lastUpdatedAt"],
    data["last_updated_at"],
    data["updatedAt"],
    data["updated_at"],
    data["lastActivityAt"],
    data["last_activity_at"],
    data["completedAt"],
    data["completed_at"],
    data["createdAt"],
    data["created_at"],
    data["timestamp"],
  ];

  let latest = 0;
  for (const candidate of directCandidates) {
    latest = Math.max(latest, timestampValue(candidate) ?? 0);
  }
  latest = Math.max(latest, latestTimestampFromArray(data["messages"]));
  latest = Math.max(latest, latestTimestampFromArray(data["taskPlan"]));
  latest = Math.max(latest, latestTimestampFromArray(data["taskQueue"]));

  return latest;
}

function hasRunningAgent(node: CanvasNode): boolean {
  const data = asRecord(node.data);
  if (!data) return false;

  const status =
    typeof data["status"] === "string" ? data["status"] : null;
  if (
    (node.type === "leader" ||
      node.type === "minion" ||
      node.type === "claude-session") &&
    status != null &&
    RUNNING_AGENT_STATUSES.has(status)
  ) {
    return true;
  }

  if (node.type !== "leader" || !Array.isArray(data["taskPlan"])) {
    return false;
  }

  return data["taskPlan"].some((task) => {
    const rec = asRecord(task);
    return (
      typeof rec?.["status"] === "string" &&
      RUNNING_AGENT_STATUSES.has(rec["status"])
    );
  });
}

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
  const originalIndex = new Map(nodes.map((n, index) => [n.id, index]));
  const nodeFreshness = new Map(
    nodes.map((n, index) => [
      n.id,
      {
        hasRunningAgent: hasRunningAgent(n),
        updatedAt: nodeLastUpdatedAt(n),
        index,
      },
    ]),
  );

  function compareNodesByFreshness(a: CanvasNode, b: CanvasNode): number {
    const af = nodeFreshness.get(a.id)!;
    const bf = nodeFreshness.get(b.id)!;
    const runningDelta =
      Number(bf.hasRunningAgent) - Number(af.hasRunningAgent);
    if (runningDelta !== 0) return runningDelta;

    const updatedDelta = bf.updatedAt - af.updatedAt;
    if (updatedDelta !== 0) return updatedDelta;

    return af.index - bf.index;
  }

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
  // Each leader claims its child nodes (minions via task-assignment
  // out-edges, dashboards via leaderId data field) and context
  // providers (context in-edges).  First-come-first-served
  // deduplication prevents a shared context node from appearing in
  // two clusters simultaneously.
  const assignedIds = new Set<string>();

  interface Cluster {
    leader: CanvasNode;
    /** Child nodes placed to the right: minions + dashboards. */
    children: CanvasNode[];
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
      .filter((n): n is CanvasNode => !!n && !assignedIds.has(n.id))
      .sort(compareNodesByFreshness);

    const children = [...minions].sort(compareNodesByFreshness);

    assignedIds.add(node.id);
    for (const ch of children) assignedIds.add(ch.id);
    for (const c of contextNodes) assignedIds.add(c.id);

    clusters.push({ leader: node, children, contextNodes });
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
    const { leader, children, contextNodes } = c;

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

    // Children (minions): stacked vertically to the right of the leader.
    // The column starts at the leader's top edge and each child is placed
    // below the previous one.
    if (children.length > 0) {
      let childY = leaderY;
      const childX = leader.size.width + CHILD_GAP_X;
      for (const ch of children) {
        pos.set(ch.id, { x: childX, y: childY });
        childY += ch.size.height + NODE_GAP;
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

  // ── Phase 3: Detect chains and group clusters into rows ──────
  // A "chain" is two or more leaders connected via dashboard→leader
  // context edges: LeaderA owns DashboardA (data.leaderId === A),
  // and DashboardA is the source of a context edge whose target is
  // LeaderB's context-in port.  Chains are sequenced horizontally
  // on a single row so the data-flow reads left-to-right.
  type LaidOutCluster = (typeof clusterLayouts)[number];

  const clusterByLeaderId = new Map<string, LaidOutCluster>();
  for (const cl of clusterLayouts) {
    clusterByLeaderId.set(cl.cluster.leader.id, cl);
  }

  function clusterNodes(cl: LaidOutCluster): CanvasNode[] {
    return [
      cl.cluster.leader,
      ...cl.cluster.children,
      ...cl.cluster.contextNodes,
    ];
  }

  function clusterLastUpdatedAt(cl: LaidOutCluster): number {
    return clusterNodes(cl).reduce(
      (latest, node) =>
        Math.max(latest, nodeFreshness.get(node.id)?.updatedAt ?? 0),
      0,
    );
  }

  function clusterHasRunningAgent(cl: LaidOutCluster): boolean {
    return clusterNodes(cl).some(
      (node) => nodeFreshness.get(node.id)?.hasRunningAgent === true,
    );
  }

  function compareClustersByFreshness(
    a: LaidOutCluster,
    b: LaidOutCluster,
  ): number {
    const runningDelta =
      Number(clusterHasRunningAgent(b)) - Number(clusterHasRunningAgent(a));
    if (runningDelta !== 0) return runningDelta;

    const updatedDelta = clusterLastUpdatedAt(b) - clusterLastUpdatedAt(a);
    if (updatedDelta !== 0) return updatedDelta;

    return (
      (originalIndex.get(a.cluster.leader.id) ?? 0) -
      (originalIndex.get(b.cluster.leader.id) ?? 0)
    );
  }

  function groupHasRunningAgent(group: LaidOutCluster[]): boolean {
    return group.some(clusterHasRunningAgent);
  }

  function groupLastUpdatedAt(group: LaidOutCluster[]): number {
    return group.reduce(
      (latest, cl) => Math.max(latest, clusterLastUpdatedAt(cl)),
      0,
    );
  }

  function compareGroupsByFreshness(
    a: LaidOutCluster[],
    b: LaidOutCluster[],
  ): number {
    const runningDelta =
      Number(groupHasRunningAgent(b)) - Number(groupHasRunningAgent(a));
    if (runningDelta !== 0) return runningDelta;

    const updatedDelta = groupLastUpdatedAt(b) - groupLastUpdatedAt(a);
    if (updatedDelta !== 0) return updatedDelta;

    const aLeader = a[0]?.cluster.leader.id;
    const bLeader = b[0]?.cluster.leader.id;
    return (
      (originalIndex.get(aLeader ?? "") ?? 0) -
      (originalIndex.get(bLeader ?? "") ?? 0)
    );
  }

  const chainOut = new Map<string, string[]>();
  const chainIn = new Map<string, string[]>();
  for (const cl of clusterLayouts) {
    chainOut.set(cl.cluster.leader.id, []);
    chainIn.set(cl.cluster.leader.id, []);
  }

  for (const cl of clusterLayouts) {
    // The leader now exports its embedded dashboard as context directly (the
    // standalone render node was retired), so chain clusters via the leader's
    // own context-out edges.
    const upstream = cl.cluster.leader.id;
    for (const e of edges) {
      if (
        e.sourceNodeId !== upstream ||
        e.protocol !== "context" ||
        !clusterByLeaderId.has(e.targetNodeId) ||
        e.targetNodeId === upstream
      ) {
        continue;
      }
      const downstream = e.targetNodeId;
      const outs = chainOut.get(upstream)!;
      if (!outs.includes(downstream)) {
        outs.push(downstream);
        chainIn.get(downstream)!.push(upstream);
      }
    }
  }

  // Group clusters into weakly-connected components, then order each
  // component via topological sort (Kahn) so producers come first.
  const visitedLeaders = new Set<string>();
  const orderedGroups: LaidOutCluster[][] = [];

  for (const cl of clusterLayouts) {
    const startId = cl.cluster.leader.id;
    if (visitedLeaders.has(startId)) continue;

    const componentIds = new Set<string>();
    const queue: string[] = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (componentIds.has(id)) continue;
      componentIds.add(id);
      for (const n of chainOut.get(id) ?? []) {
        if (!componentIds.has(n)) queue.push(n);
      }
      for (const n of chainIn.get(id) ?? []) {
        if (!componentIds.has(n)) queue.push(n);
      }
    }
    for (const id of componentIds) visitedLeaders.add(id);

    const indeg = new Map<string, number>();
    for (const id of componentIds) {
      indeg.set(
        id,
        (chainIn.get(id) ?? []).filter((p) => componentIds.has(p)).length,
      );
    }
    const ready: string[] = [];
    for (const id of componentIds) {
      if ((indeg.get(id) ?? 0) === 0) ready.push(id);
    }
    ready.sort((a, b) =>
      compareClustersByFreshness(
        clusterByLeaderId.get(a)!,
        clusterByLeaderId.get(b)!,
      ),
    );
    const ordered: string[] = [];
    const orderedSet = new Set<string>();
    while (ready.length > 0) {
      const id = ready.shift()!;
      ordered.push(id);
      orderedSet.add(id);
      for (const next of chainOut.get(id) ?? []) {
        if (!componentIds.has(next)) continue;
        indeg.set(next, (indeg.get(next) ?? 0) - 1);
        if (indeg.get(next) === 0) {
          ready.push(next);
          ready.sort((a, b) =>
            compareClustersByFreshness(
              clusterByLeaderId.get(a)!,
              clusterByLeaderId.get(b)!,
            ),
          );
        }
      }
    }
    // Cycles: append remaining members in input order so nothing is dropped.
    const remaining = [...componentIds]
      .filter((id) => !orderedSet.has(id))
      .sort((a, b) =>
        compareClustersByFreshness(
          clusterByLeaderId.get(a)!,
          clusterByLeaderId.get(b)!,
        ),
      );
    for (const id of remaining) {
      if (!orderedSet.has(id)) ordered.push(id);
    }

    orderedGroups.push(ordered.map((id) => clusterByLeaderId.get(id)!));
  }

  // Order independent content by recency. Multi-cluster chains remain
  // producer-first internally, but the chain as a unit participates in
  // freshness ordering with every other cluster.
  const sortedGroups = [...orderedGroups].sort(compareGroupsByFreshness);

  // Pack every workstream unit — a singleton leader cluster or a
  // multi-cluster chain — into a single horizontal row flow ordered by
  // freshness.  A unit's clusters stay contiguous (producer-first for
  // chains) so connected workstreams read together, and we wrap to a
  // new row only when appending the whole unit would push the row past
  // MAX_ROW_WIDTH.  A unit wider than MAX_ROW_WIDTH simply occupies its
  // own row and overflows rather than being split.
  const allRows: LaidOutCluster[][] = [];
  let currentRow: LaidOutCluster[] = [];

  function rowWidth(row: LaidOutCluster[]): number {
    if (row.length === 0) return 0;
    return (
      row.reduce((s, cl) => s + cl.rect.w, 0) + CLUSTER_GAP * (row.length - 1)
    );
  }

  for (const group of sortedGroups) {
    const prospective = [...currentRow, ...group];
    if (currentRow.length > 0 && rowWidth(prospective) > MAX_ROW_WIDTH) {
      allRows.push(currentRow);
      currentRow = [...group];
    } else {
      currentRow = prospective;
    }
  }
  if (currentRow.length > 0) allRows.push(currentRow);

  function rowDimensions(row: LaidOutCluster[]): { w: number; h: number } {
    if (row.length === 0) return { w: 0, h: 0 };
    const w =
      row.reduce((s, cl) => s + cl.rect.w, 0) +
      CLUSTER_GAP * (row.length - 1);
    const h = row.reduce((m, cl) => Math.max(m, cl.rect.h), 0);
    return { w, h };
  }

  const rowDims = allRows.map(rowDimensions);

  // ── Phase 4: Determine layout origin ─────────────────────────
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

  const totalClusterW = rowDims.reduce((m, r) => Math.max(m, r.w), 0);
  const totalClusterH =
    rowDims.reduce((s, r) => s + r.h, 0) +
    CLUSTER_GAP * Math.max(0, rowDims.length - 1);

  const originX = centre.x - totalClusterW / 2;
  const originY = centre.y - totalClusterH / 2;

  // ── Phase 5: Pack rows top-to-bottom, clusters left-to-right ─
  const finalPositions = new Map<string, Position>();
  let curY = originY;

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i]!;
    const dim = rowDims[i]!;
    // Centre each row horizontally within the overall layout width.
    let curX = originX + (totalClusterW - dim.w) / 2;
    for (const cl of row) {
      for (const [id, p] of cl.positions) {
        finalPositions.set(id, {
          x: Math.round(curX + p.x),
          y: Math.round(curY + p.y),
        });
      }
      curX += cl.rect.w + CLUSTER_GAP;
    }
    curY += dim.h;
    if (i < allRows.length - 1) curY += CLUSTER_GAP;
  }

  // ── Phase 6: Place isolates ──────────────────────────────────
  // Nodes not owned by any cluster and not inside a context-group.
  const isolates = nodes.filter(
    (n) => !assignedIds.has(n.id) && !insideGroupIds.has(n.id),
  ).sort(compareNodesByFreshness);

  if (isolates.length > 0) {
    let ix = originX;
    let iy = allRows.length > 0 ? curY + ISOLATE_GAP : originY;
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

  // ── Phase 7: Propagate context-group → member deltas ─────────
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
