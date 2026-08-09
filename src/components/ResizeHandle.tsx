import { useCallback, useRef } from "react";
import type { Size } from "../types.ts";
import { canvasScale } from "../canvas-scale.ts";

interface ResizeHandleProps {
  currentSize: Size;
  minWidth?: number;
  minHeight?: number;
  onResize: (size: Size) => void;
  /** Accent color for the handle dots */
  color?: string;
  /** Called when the user starts dragging the resize handle */
  onResizeStart?: () => void;
  /** Called when the user stops dragging the resize handle */
  onResizeEnd?: () => void;
}

/**
 * Drag handle rendered at the bottom-right corner of a node.
 * Fires onResize with the new width/height as the user drags.
 */
export function ResizeHandle({
  currentSize,
  minWidth = 320,
  minHeight = 280,
  onResize,
  color = "var(--text-muted)",
  onResizeStart,
  onResizeEnd,
}: ResizeHandleProps) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: currentSize.width,
        startH: currentSize.height,
      };

      onResizeStart?.();

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const scale = canvasScale.current;
        const dx = (ev.clientX - dragRef.current.startX) / scale;
        const dy = (ev.clientY - dragRef.current.startY) / scale;
        onResize({
          width: Math.max(minWidth, dragRef.current.startW + dx),
          height: Math.max(minHeight, dragRef.current.startH + dy),
        });
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        onResizeEnd?.();
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
      };

      document.body.style.cursor = "nwse-resize";
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [currentSize, minWidth, minHeight, onResize, onResizeStart, onResizeEnd],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: "absolute",
        right: 0,
        bottom: 0,
        width: 18,
        height: 18,
        cursor: "nwse-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
        borderRadius: "0 0 8px 0",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.5 }}>
        <circle cx="8" cy="2" r="1" fill={color} />
        <circle cx="4" cy="6" r="1" fill={color} />
        <circle cx="8" cy="6" r="1" fill={color} />
        <circle cx="8" cy="10" r="1" fill={color} />
      </svg>
    </div>
  );
}
