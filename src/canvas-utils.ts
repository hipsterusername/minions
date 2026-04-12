/**
 * Shared utility functions for canvas operations.
 */
import type { CanvasNode, CanvasTransform, Position } from "./types.ts";

// ── Grid alignment ──────────────────────────────────────────────

/** Grid cell size in world units — nodes snap to multiples of this value. */
export const GRID_SNAP = 24;

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
export function viewportCenter(transform: CanvasTransform): Position {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    x: (w / 2 - transform.x) / transform.scale,
    y: (h / 2 - transform.y) / transform.scale,
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
