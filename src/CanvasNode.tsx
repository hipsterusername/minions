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

  /** Always absorb wheel events on nodes so the canvas never zooms
   *  while the pointer is over a node. Scrollable children still scroll
   *  normally — we just prevent the event from reaching the canvas. */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
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
        canvasScale={transform.scale}
      />
    </div>
  );
}
