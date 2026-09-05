import { useCallback, useEffect, useRef, useState } from "react";
import { canvasScale } from "./canvas-scale.ts";
import type { CanvasNode, Position } from "./types.ts";

interface Options {
  node: CanvasNode;
  isSelected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onMove: (id: string, position: Position, cancelled?: boolean) => void;
  onDragStart?: ((id: string, event?: MouseEvent) => void) | undefined;
  onDragEnd?: ((id: string, event?: MouseEvent) => void) | undefined;
}

export function useCanvasNodeDrag({ node, isSelected, onSelect, onMove, onDragStart, onDragEnd }: Options) {
  const [pointer, setPointer] = useState<Position | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0 || (event.target as Element).closest(
      "input,textarea,select,button,a,label,[contenteditable],[data-no-drag]")) return;
    event.stopPropagation(); event.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const deferSelection = isSelected && !event.shiftKey;
    if (!deferSelection) onSelect(node.id, event.shiftKey);
    const start = { x: event.clientX, y: event.clientY };
    const origin = { ...node.position };
    const userSelect = document.body.style.userSelect;
    const cursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    let started = false;
    const move = (e: MouseEvent) => {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!started) {
        if (Math.abs(dx) + Math.abs(dy) <= 3) return;
        started = true;
        document.body.style.cursor = "grabbing";
        onDragStart?.(node.id, e);
      }
      setPointer({ x: e.clientX, y: e.clientY });
      onMove(node.id, { x: origin.x + dx / canvasScale.current, y: origin.y + dy / canvasScale.current });
    };
    const detach = () => {
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      cleanup.current = null;
    };
    const end = (e?: MouseEvent) => {
      detach(); setPointer(null);
      if (started) {
        if (!e) onMove(node.id, origin, true);
        onDragEnd?.(node.id, e);
      } else if (deferSelection && e) onSelect(node.id, false);
    };
    const cancel = () => end();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = detach;
  }, [node.id, node.type, node.position, isSelected, onSelect, onMove, onDragStart, onDragEnd]);
  return { pointer, onMouseDown };
}
