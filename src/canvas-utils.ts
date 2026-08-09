/**
 * Shared utility functions for canvas operations.
 */
import type { CanvasNode, CanvasTransform, Position, Size } from "./types.ts";

// ── Grid alignment ──────────────────────────────────────────────

/** Grid cell size in world units — nodes snap to multiples of this value. */
export const GRID_SNAP = 24;

/** Visual gutter between an affixed Leader and its dashboard. */
export const DASHBOARD_LEADER_GUTTER = 4;

/** Snap a value to the nearest grid line. */
export function snapToGrid(v: number): number {
  return Math.round(v / GRID_SNAP) * GRID_SNAP;
}

/** Snap a position to the nearest grid intersection. */
export function snapPositionToGrid(pos: Position): Position {
  return { x: snapToGrid(pos.x), y: snapToGrid(pos.y) };
}

// ── Viewport helpers ────────────────────────────────────────────

/** Calculate the canvas-space center of the current viewport.
 *  Useful for placing new nodes where the user is currently looking. */
export function viewportCenter(
  transform: CanvasTransform,
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight,
  },
): Position {
  const w = viewport.width;
  const h = viewport.height;
  return {
    x: (w / 2 - transform.x) / transform.scale,
    y: (h / 2 - transform.y) / transform.scale,
  };
}

/** Fit one or more world-space rectangles inside the viewport and center them. */
export function focusTransformOnRects(
  rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  viewport: { width: number; height: number },
  options: { padding: number; maxScale: number },
): CanvasTransform | null {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) return null;

  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  const contentWidth = maxX - minX + options.padding * 2;
  const contentHeight = maxY - minY + options.padding * 2;
  const fitScale = Math.min(viewport.width / contentWidth, viewport.height / contentHeight);
  const scale = Math.min(options.maxScale, fitScale);

  return centerTransformOnRect(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    viewport,
    scale,
  );
}

/**
 * Compute the {@link CanvasTransform} that centers a world-space rectangle in
 * the viewport, preserving the given zoom `scale` (pan only). Used to
 * reposition the camera onto a node after it is dragged to a new placement.
 *
 * `viewport` is the container's pixel size. The returned transform places the
 * rect's center at the viewport's center.
 */
export function centerTransformOnRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  scale: number,
): CanvasTransform {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return {
    x: viewport.width / 2 - centerX * scale,
    y: viewport.height / 2 - centerY * scale,
    scale,
  };
}

/**
 * Whether a drag moved a node far enough to count as a reposition worth
 * recentering the camera on. Guards against sub-pixel / no-op drops (e.g. a
 * click that registered a tiny move) triggering a jarring camera glide.
 */
export function didReposition(
  start: Position | null | undefined,
  end: Position | null | undefined,
  threshold = 2,
): boolean {
  if (!start || !end) return false;
  return Math.abs(end.x - start.x) + Math.abs(end.y - start.y) > threshold;
}

// ── Stacked placement ───────────────────────────────────────────

/** Vertical gap between a newly-stacked node and the card it sits above. */
export const ABOVE_TOP_GAP = 48;

/**
 * Compute the top-left position for a new node placed directly above the
 * current top-most card on the canvas.
 *
 * "Top-most" = the node with the smallest Y (highest on screen). The new
 * node is horizontally aligned to that card and stacked above it with a
 * vertical gap. When the canvas is empty, `fallback` (already a top-left
 * position) is returned unchanged.
 */
export function placeAboveTopNode(
  nodes: CanvasNode[],
  size: Size,
  gap: number,
  fallback: Position,
): Position {
  let top: CanvasNode | null = null;
  for (const n of nodes) {
    if (top === null || n.position.y < top.position.y) top = n;
  }
  if (top === null) return { ...fallback };
  return {
    x: top.position.x,
    y: top.position.y - size.height - gap,
  };
}

// ── Overlap detection & avoidance ───────────────────────────────

/** Padding between nodes when finding non-overlapping positions (px). */
const PLACEMENT_PAD = 16;

/** Check whether two axis-aligned rectangles overlap (with optional padding). */
function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
  pad = 0,
): boolean {
  return !(
    ax > bx + bw + pad ||
    ax + aw + pad < bx ||
    ay > by + bh + pad ||
    ay + ah + pad < by
  );
}

/** Test whether a candidate rectangle overlaps any existing node. */
function overlapsAny(
  x: number, y: number, w: number, h: number,
  nodes: CanvasNode[],
  pad = PLACEMENT_PAD,
): boolean {
  return nodes.some((n) =>
    rectsOverlap(
      x, y, w, h,
      n.position.x, n.position.y, n.size.width, n.size.height,
      pad,
    ),
  );
}

/**
 * Find a grid-aligned position for a new node that doesn't overlap
 * existing nodes.
 *
 * Strategy:
 *  1. Try the requested position (snapped to grid).
 *  2. Search outward in concentric rings using cardinal + diagonal
 *     directions, prioritising right and below (the natural reading
 *     direction) so nodes form tidy rows/columns.
 *
 * The result is always snapped to the grid.
 */
export function findNonOverlappingPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  existingNodes: CanvasNode[],
): Position {
  // Snap the initial candidate to the grid
  let cx = snapToGrid(x);
  let cy = snapToGrid(y);

  if (!overlapsAny(cx, cy, w, h, existingNodes)) {
    return { x: cx, y: cy };
  }

  // Step size — use a grid-aligned step that's at least as large as the
  // node dimension + padding so each ring is guaranteed to clear the
  // previous candidate.
  const stepX = snapToGrid(w + PLACEMENT_PAD + GRID_SNAP);
  const stepY = snapToGrid(h + PLACEMENT_PAD + GRID_SNAP);

  // Directions ordered to prefer right → below → left → above, then diagonals
  const directions: [number, number][] = [
    [1, 0],   // right
    [0, 1],   // below
    [-1, 0],  // left
    [0, -1],  // above
    [1, 1],   // bottom-right
    [-1, 1],  // bottom-left
    [1, -1],  // top-right
    [-1, -1], // top-left
  ];

  // Search outward in rings (up to 8 rings = very generous)
  for (let ring = 1; ring <= 8; ring++) {
    for (const [dx, dy] of directions) {
      const testX = snapToGrid(x + dx * ring * stepX);
      const testY = snapToGrid(y + dy * ring * stepY);
      if (!overlapsAny(testX, testY, w, h, existingNodes)) {
        return { x: testX, y: testY };
      }
    }
  }

  // Fallback: offset diagonally (should rarely happen)
  return { x: snapToGrid(x + 30 * 20), y: snapToGrid(y + 30 * 20) };
}

// ── Tidy-layout drag decisions ──────────────────────────────────

/**
 * Whether a drag-end drop should trigger tidy relocation for this node.
 * Excludes context-group frames (they intentionally contain overlapping
 * nodes) and multi-select drags (a deliberate manual arrangement). Callers
 * gate on tidy layout being on before calling this.
 */
export function shouldRelocateOnDrop(
  node: CanvasNode,
  isMultiSelect: boolean,
): boolean {
  return node.type !== "context-group" && !isMultiSelect;
}

// ── Drag-end tidy placement ─────────────────────────────────────

/** Axis-aligned bounding box that encloses every node in the set. */
function boundingBox(
  nodes: CanvasNode[],
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.size.width);
    maxY = Math.max(maxY, n.position.y + n.size.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Resolve a drag-end drop for a set of nodes that move together (`movers`,
 * e.g. a leader plus its minions/dashboards) so their combined bounding box
 * sits **flush** against the node it collides with, rather than scattering
 * onto a fine grid.
 *
 * When the box overlaps a neighbour, it snaps to one of the neighbour's four
 * sides — right/left keep the top edges aligned, top/bottom keep the left
 * edges aligned — separated by a small consistent `gutter`. The side is
 * chosen by where the box was dropped (a proxy for the cursor): the candidate
 * nearest the drop point wins, so a node dropped to the right snaps right, one
 * dropped below snaps below, and so on. If that side is occupied the next
 * nearest free side is used; if all four are blocked it falls back to an
 * outward search.
 *
 * With no collision the box origin is snapped to the grid so free drops stay
 * tidy. Relative offsets between movers are always preserved exactly.
 *
 * Returns the delta to apply to every mover.
 */
export function resolveTidyDrop(
  movers: CanvasNode[],
  obstacles: CanvasNode[],
  gutter = PLACEMENT_PAD,
): { dx: number; dy: number } {
  if (movers.length === 0) return { dx: 0, dy: 0 };
  const box = boundingBox(movers);

  // The neighbour the dropped box overlaps most becomes the anchor to snap to.
  let primary: CanvasNode | null = null;
  let bestOverlap = 0;
  for (const o of obstacles) {
    const ow =
      Math.min(box.x + box.width, o.position.x + o.size.width) -
      Math.max(box.x, o.position.x);
    const oh =
      Math.min(box.y + box.height, o.position.y + o.size.height) -
      Math.max(box.y, o.position.y);
    const area = Math.max(0, ow) * Math.max(0, oh);
    if (area > bestOverlap) {
      bestOverlap = area;
      primary = o;
    }
  }

  // No collision → keep free drops tidy by snapping the origin to the grid.
  if (!primary) {
    return { dx: snapToGrid(box.x) - box.x, dy: snapToGrid(box.y) - box.y };
  }

  const bx = primary.position.x;
  const by = primary.position.y;
  const bw = primary.size.width;
  const bh = primary.size.height;

  // Four flush, edge-aligned candidate origins for the box.
  const candidates = [
    { x: bx + bw + gutter, y: by }, // right, tops aligned
    { x: bx - box.width - gutter, y: by }, // left, tops aligned
    { x: bx, y: by + bh + gutter }, // below, left edges aligned
    { x: bx, y: by - box.height - gutter }, // above, left edges aligned
  ];

  // Prefer the side nearest to where the box was dropped (cursor proxy).
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - box.x, a.y - box.y) -
      Math.hypot(b.x - box.x, b.y - box.y),
  );

  for (const c of candidates) {
    // The candidate is flush to `primary` by construction; just make sure it
    // doesn't land on any *other* node.
    const hitsOther = obstacles.some(
      (o) =>
        o !== primary &&
        rectsOverlap(
          c.x, c.y, box.width, box.height,
          o.position.x, o.position.y, o.size.width, o.size.height,
          0,
        ),
    );
    if (!hitsOther) return { dx: c.x - box.x, dy: c.y - box.y };
  }

  // Every flush side is occupied — fall back to the outward ring search.
  const free = findNonOverlappingPosition(
    box.x, box.y, box.width, box.height, obstacles,
  );
  return { dx: free.x - box.x, dy: free.y - box.y };
}

// ── Cluster repositioning helpers ───────────────────────────────

/**
 * Push nodes that overlap a newly-inserted rectangle out of the way.
 *
 * Used when a dashboard or minion is spawned to ensure existing nodes
 * don't get hidden behind the new arrival.
 *
 * Returns an array of moves (empty if nothing needs to shift).
 */
export function pushNodesFromRect(
  rect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  excludeIds: Set<string>,
  direction: "right" | "down" = "right",
): Array<{ id: string; position: Position }> {
  const moves: Array<{ id: string; position: Position }> = [];
  const pad = PLACEMENT_PAD;

  for (const n of nodes) {
    if (excludeIds.has(n.id)) continue;

    const overlaps = rectsOverlap(
      rect.x, rect.y, rect.width, rect.height,
      n.position.x, n.position.y, n.size.width, n.size.height,
      pad,
    );

    if (overlaps) {
      let newPos: Position;
      if (direction === "right") {
        newPos = {
          x: snapToGrid(rect.x + rect.width + pad),
          y: snapToGrid(n.position.y),
        };
      } else {
        newPos = {
          x: snapToGrid(n.position.x),
          y: snapToGrid(rect.y + rect.height + pad),
        };
      }
      moves.push({ id: n.id, position: newPos });
    }
  }

  return moves;
}
