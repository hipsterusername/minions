import type { CanvasNode, Position, Size } from "./types.ts";

// Screen pixels: capture gently, then tolerate a wider range before releasing.
export const DRAG_SNAP_CAPTURE = 12;
export const DRAG_SNAP_RELEASE = 24;
const NEIGHBOR_RANGE = 72;
const GUTTER = 16;
export interface DragSnap { key: string; position: Position }

/** Magnetic vertical alignment of a node/cluster; raw coordinates never accumulate snap offsets. */
export function resolveDragSnap(box: Position & Size, obstacles: CanvasNode[], scale: number,
  previous: DragSnap | null = null): DragSnap | null {
  const zoom = Math.max(.01, scale);
  const candidates: (DragSnap & { distance: number })[] = [];
  const clear = (p: Position) => obstacles.every(o =>
    p.x + box.width + GUTTER <= o.position.x || p.x >= o.position.x + o.size.width + GUTTER ||
    p.y + box.height + GUTTER <= o.position.y || p.y >= o.position.y + o.size.height + GUTTER);
  for (const o of obstacles) {
    const horizontalGap = Math.max(o.position.x - box.x - box.width, box.x - o.position.x - o.size.width, 0);
    if (horizontalGap * zoom > NEIGHBOR_RANGE) continue;
    const ys = [o.position.y, o.position.y + o.size.height - box.height,
      o.position.y - box.height - GUTTER, o.position.y + o.size.height + GUTTER];
    for (const [yi, y] of ys.entries()) {
      if (Math.abs(y - box.y) * zoom > DRAG_SNAP_RELEASE) continue;
      const xs = yi < 2 ? [box.x] : [box.x, o.position.x,
        o.position.x + (o.size.width - box.width) / 2, o.position.x + o.size.width - box.width];
      // Nearby diagonal slots can clear a partial blocker above or below.
      if (yi >= 2) for (const other of obstacles) xs.push(
        other.position.x - box.width - GUTTER, other.position.x + other.size.width + GUTTER);
      for (const [xi, x] of xs.entries()) {
        const key = `${o.id}:${yi}:${xi === 0 ? "free-x" : x}`;
        const threshold = previous?.key === key ? DRAG_SNAP_RELEASE : DRAG_SNAP_CAPTURE;
        const distance = Math.hypot(x - box.x, y - box.y) * zoom;
        if (distance > threshold || !clear({ x, y })) continue;
        // Stack points must share horizontal space with the target node.
        if (yi >= 2 && (x >= o.position.x + o.size.width || x + box.width <= o.position.x)) continue;
        candidates.push({ key, position: { x, y }, distance });
      }
    }
  }
  const held = candidates.find(c => c.key === previous?.key);
  candidates.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
  if (held) {
    // A free-X shelf can acquire edge/center alignment as the user slides along it.
    return held.key.endsWith("free-x")
      ? candidates.find(c => c.position.y === held.position.y && !c.key.endsWith("free-x")) ?? held
      : held;
  }
  const nearest = candidates[0];
  if (!nearest) return null;
  // When stacking, magnetize a nearby horizontal edge/center too. Prefer it
  // only within the same vertical slot, so a farther row cannot steal the drag.
  const aligned = candidates.filter(c => c.position.y === nearest.position.y && !c.key.endsWith("free-x"));
  return aligned[0] ?? nearest;
}
