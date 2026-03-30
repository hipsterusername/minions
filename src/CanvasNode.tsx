import { useCallback, useRef } from "react";
import type { CanvasNode, CanvasTransform, Position, Size } from "./types.ts";
import { getNodeType } from "./node-registry.ts";

interface CanvasNodeProps {
  node: CanvasNode;
  transform: CanvasTransform;
  isSelected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onMove: (id: string, position: Position) => void;
  onUpdateData: (id: string, data: unknown) => void;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: (fn: (msg: unknown) => void) => () => void;
  getContextForNode?: () => import("./types.ts").ContextItem[];
  projectPath?: string;
  onResize?: (id: string, size: Size) => void;
}

/** Walk from the event target up to (but not including) the node root,
 *  looking for the first element with scrollable overflow.  If found,
 *  return it — otherwise return null. */
function findScrollableAncestor(
  target: EventTarget | null,
  boundary: HTMLElement,
): HTMLElement | null {
  let el = target as HTMLElement | null;
  while (el && el !== boundary) {
    const { overflowY } = getComputedStyle(el);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

export function CanvasNodeComponent({
  node,
  transform,
  isSelected,
  onSelect,
  onMove,
  onUpdateData,
  socketSend,
  socketSubscribe,
  getContextForNode,
  projectPath,
  onResize,
}: CanvasNodeProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    nodeStartX: number;
    nodeStartY: number;
  } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      onSelect(node.id, e.shiftKey);

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        nodeStartX: node.position.x,
        nodeStartY: node.position.y,
      };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = (ev.clientX - dragRef.current.startX) / transform.scale;
        const dy = (ev.clientY - dragRef.current.startY) / transform.scale;
        onMove(node.id, {
          x: dragRef.current.nodeStartX + dx,
          y: dragRef.current.nodeStartY + dy,
        });
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [node.id, node.position, transform.scale, onSelect, onMove],
  );

  /** If the wheel event is over a scrollable child, absorb it so the
   *  canvas zoom handler never fires; otherwise let it bubble. */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!nodeRef.current) return;
    const scrollable = findScrollableAncestor(e.target, nodeRef.current);
    if (!scrollable) return; // nothing scrollable — let canvas zoom

    const { scrollTop, scrollHeight, clientHeight } = scrollable;
    const atTop = scrollTop <= 0 && e.deltaY < 0;
    const atBottom =
      scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;

    // If the scrollable area still has room in the scroll direction, eat the event.
    if (!atTop && !atBottom) {
      e.stopPropagation();
    }
    // At the boundary → let it bubble to canvas for zoom.
  }, []);

  // Stable callback — only changes when node.id or parent handler changes,
  // preventing child useEffect subscriptions from tearing down every render.
  const handleNodeUpdate = useCallback(
    (data: unknown) => onUpdateData(node.id, data),
    [node.id, onUpdateData],
  );

  const handleResize = useCallback(
    (size: Size) => onResize?.(node.id, size),
    [node.id, onResize],
  );

  const typeDef = getNodeType(node.type);
  if (!typeDef) return null;

  const NodeRenderer = typeDef.render;

  return (
    <div
      ref={nodeRef}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      style={{
        position: "absolute",
        left: node.position.x,
        top: node.position.y,
        width: node.size.width,
        ...(typeDef.autoHeight
          ? { minHeight: node.size.height, height: "auto" }
          : { height: node.size.height }),
        cursor: "grab",
        outline: isSelected
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        outlineOffset: 2,
        borderRadius: 10,
        transition: "outline-color 0.15s",
        zIndex: isSelected ? 10 : 1,
      }}
    >
      <NodeRenderer
        node={node}
        isSelected={isSelected}
        onUpdateData={handleNodeUpdate}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
        getContextForNode={getContextForNode}
        projectPath={projectPath}
        onResize={handleResize}
      />
    </div>
  );
}
