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

/** Forbidden origins for the moving box; the boundary itself has a full gutter. */
interface DropExclusion { left: number; right: number; top: number; bottom: number }

function excludesPoint(rect: DropExclusion, point: Position): boolean {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

/**
 * The nearest free origin is either at the requested X or on an exclusion's
 * vertical boundary. At each such X, merge blocked Y intervals and project
 * the requested Y to the closest free endpoint. This includes diagonal gaps
 * without a bounded ring search or a preferred compass direction.
 * O(n²) worst case; distant X candidates are pruned once a fit is found.
 */
function nearestDropOrigin(target: Position, exclusions: DropExclusion[]): Position {
  const xs = [...new Set([target.x, ...exclusions.flatMap(r => [r.right, r.left])])]
    .sort((a, b) => Math.abs(a - target.x) - Math.abs(b - target.x) || b - a);
  const byTop = [...exclusions].sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  let best = target;
  let bestDistance = Infinity;
  for (const x of xs) {
    const dxSquared = (x - target.x) ** 2;
    if (dxSquared > bestDistance) break;
    const intervals: { top: number; bottom: number }[] = [];
    for (const r of byTop) {
      if (x <= r.left || x >= r.right) continue;
      const last = intervals.at(-1);
      // Touching intervals leave a valid, exact-gutter opening between them.
      if (last && r.top < last.bottom) last.bottom = Math.max(last.bottom, r.bottom);
      else intervals.push({ top: r.top, bottom: r.bottom });
    }
    const blocked = intervals.find(r => target.y > r.top && target.y < r.bottom);
    const y = !blocked ? target.y
      : target.y - blocked.top < blocked.bottom - target.y ? blocked.top : blocked.bottom;
    const distance = dxSquared + (y - target.y) ** 2;
    // Stable ties retain X first, then prefer below/right for identical drops.
    if (distance < bestDistance) {
      best = { x, y };
      bestDistance = distance;
    }
  }
  return best;
}

/** Only magnetize edges already within one grid cell of the user's drop. */
function alignDropAxis(value: number, start: number, end: number): number {
  const edge = Math.abs(value - start) <= Math.abs(value - end) ? start : end;
  return Math.abs(value - edge) <= GRID_SNAP ? edge : value;
}

/**
 * Find the closest open placement for a dragged node or cluster. Nearby edges
 * align, but partial blockers can slide the placement along a side or into a
 * diagonal opening instead of cycling through four fixed slots. Every obstacle
 * gets the same gutter, and relative offsets between movers stay exact.
 * Free drops grid-snap only when that position is clear too.
 */
export function resolveTidyDrop(
  movers: CanvasNode[],
  obstacles: CanvasNode[],
  gutter = PLACEMENT_PAD,
): { dx: number; dy: number } {
  if (movers.length === 0) return { dx: 0, dy: 0 };
  const box = boundingBox(movers);
  const exclusions = obstacles.map(o => ({
    left: o.position.x - box.width - gutter,
    right: o.position.x + o.size.width + gutter,
    top: o.position.y - box.height - gutter,
    bottom: o.position.y + o.size.height + gutter,
  }));

  // Largest overlap is the alignment anchor. Break ties independently of node
  // array order so reordering the canvas cannot change the preview.
  let primary: CanvasNode | null = null;
  let bestOverlap = 0;
  for (const o of obstacles) {
    const ow = Math.min(box.x + box.width, o.position.x + o.size.width) - Math.max(box.x, o.position.x);
    const oh = Math.min(box.y + box.height, o.position.y + o.size.height) - Math.max(box.y, o.position.y);
    const area = Math.max(0, ow) * Math.max(0, oh);
    if (area > bestOverlap || (area > 0 && area === bestOverlap && primary && o.id < primary.id)) {
      bestOverlap = area;
      primary = o;
    }
  }

  if (!primary) {
    const snapped = snapPositionToGrid(box);
    if (!exclusions.some(r => excludesPoint(r, snapped))) {
      return { dx: snapped.x - box.x, dy: snapped.y - box.y };
    }
  }

  const target = primary ? {
    x: alignDropAxis(box.x, primary.position.x, primary.position.x + primary.size.width - box.width),
    y: alignDropAxis(box.y, primary.position.y, primary.position.y + primary.size.height - box.height),
  } : box;
  const free = nearestDropOrigin(target, exclusions);
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
