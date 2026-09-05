import { useCallback, useRef } from "react";
import { canvasDropPlacement } from "./canvas-drop-placement.ts";
import { resolveDragSnap, type DragSnap } from "./canvas-drag-snap.ts";
import type { CanvasNode, Position } from "./types.ts";

export function useCanvasDragSnap(nodes: CanvasNode[], visible: CanvasNode[], selected: Set<string>,
  scale: number, enabled: boolean) {
  const latest = useRef({ nodes, visible, selected, scale, enabled });
  latest.current = { nodes, visible, selected, scale, enabled };
  const active = useRef<{ id: string; snap: DragSnap | null; hasSnapped: boolean } | null>(null);
  const begin = useCallback((id: string) => {
    active.current = { id, snap: null, hasSnapped: false };
  }, []);
  const move = useCallback((id: string, position: Position, cancelled = false): Position => {
    const state = active.current;
    const { nodes, visible, selected, scale, enabled } = latest.current;
    const node = nodes.find(n => n.id === id);
    if (!state || state.id !== id || !node) return position;
    if (cancelled || !enabled || node.type === "context-group" ||
      nodes.some(n => selected.has(n.id) && n.type === "context-group")) {
      state.snap = null;
      state.hasSnapped = false;
      return position;
    }
    const moves = canvasDropPlacement(node, nodes, visible, selected, false);
    const ids = new Set(moves.map(m => m.id));
    const movers = nodes.filter(n => ids.has(n.id));
    const left = Math.min(...movers.map(n => n.position.x));
    const top = Math.min(...movers.map(n => n.position.y));
    const box = { x: left + position.x - node.position.x, y: top + position.y - node.position.y,
      width: Math.max(...movers.map(n => n.position.x + n.size.width)) - left,
      height: Math.max(...movers.map(n => n.position.y + n.size.height)) - top };
    const obstacles = visible.filter(n => !ids.has(n.id) && n.type !== "context-group" && n.type !== "canvas-zone");
    state.snap = resolveDragSnap(box, obstacles, scale, state.snap);
    if (state.snap) state.hasSnapped = true;
    return state.snap ? { x: position.x + state.snap.position.x - box.x,
      y: position.y + state.snap.position.y - box.y } : position;
  }, []);
  const placement = useCallback((...args: Parameters<typeof canvasDropPlacement>) => {
    const [node, nodes, visible, selected, tidy] = args;
    // Preserve both magnetic alignment and the user's deliberate breakaway.
    // Tidying after release would move the preview/drop away from the pointer.
    const preservePlacement = latest.current.enabled && active.current?.id === node.id && active.current.hasSnapped;
    return canvasDropPlacement(node, nodes, visible, selected, preservePlacement ? false : tidy);
  }, []);
  return { begin, move, placement };
}
