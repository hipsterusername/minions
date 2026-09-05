import { resolveTidyDrop, shouldRelocateOnDrop } from "./canvas-utils.ts";
import type { CanvasNode, Position } from "./types.ts";

/** Shared by the drag footprint and the committed drop, including cluster snapping. */
export function canvasDropPlacement(node: CanvasNode, nodes: CanvasNode[], visibleNodes: CanvasNode[],
  selectedIds: Set<string>, tidy = true): { id: string; position: Position }[] {
  const multi = selectedIds.has(node.id) && selectedIds.size > 1;
  const ids = multi ? selectedIds : new Set([node.id]);
  const leaders = new Set(nodes.filter(n => ids.has(n.id) && n.type === "leader").map(n => n.id));
  const movers = nodes.filter(n => ids.has(n.id) ||
    (n.type === "minion" && leaders.has((n.data as { leaderId: string }).leaderId)));
  const moverIds = new Set(movers.map(n => n.id));
  const obstacles = visibleNodes.filter(n => !moverIds.has(n.id) && n.type !== "context-group");
  const delta = tidy && shouldRelocateOnDrop(node, multi) ? resolveTidyDrop(movers, obstacles) : { dx: 0, dy: 0 };
  return movers.map(n => ({ id: n.id, position: { x: n.position.x + delta.dx, y: n.position.y + delta.dy } }));
}
