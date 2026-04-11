/**
 * Shared utility functions for canvas operations.
 */
import type { CanvasNode, CanvasTransform, Position } from "./types.ts";

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

/** Find a position for a new node that doesn't overlap existing nodes.
 *  Tries up to 20 offsets (shifted by 30px each) before giving up. */
export function findNonOverlappingPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  existingNodes: CanvasNode[],
): Position {
  let cx = x;
  let cy = y;
  let attempts = 0;
  while (attempts < 20) {
    const overlaps = existingNodes.some(
      (n) =>
        !(
          cx > n.position.x + n.size.width ||
          cx + w < n.position.x ||
          cy > n.position.y + n.size.height ||
          cy + h < n.position.y
        ),
    );
    if (!overlaps) break;
    cx += 30;
    cy += 30;
    attempts++;
  }
  return { x: cx, y: cy };
}
