import { useCallback, useRef, useState } from "react";

/**
 * Vertical drag-handle that resizes the column it's bracketed by.
 *
 * The parent owns the width state — this component just reports
 * a delta on each pointer move. Strategy:
 *   - On pointer-down, capture the pointer so the drag survives the
 *     cursor leaving the handle bounds (a common ergonomic improvement
 *     over plain mousemove listeners).
 *   - On pointer-move, fire `onResize(deltaX)` where deltaX is the
 *     pixel delta from where the drag started.
 *   - Double-click resets to the default via `onReset`.
 *
 * The visible handle is 4px wide but the hit area extends 4px on each
 * side via a transparent inset for an easier grab target.
 */
export function PaneDivider({
  side,
  onResize,
  onReset,
  ariaLabel,
}: {
  /** "left" = drag right increases left pane; "right" = drag right shrinks right pane. */
  side: "left" | "right";
  onResize: (deltaX: number) => void;
  onReset?: () => void;
  ariaLabel: string;
}) {
  const startXRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture isn't implemented in some test envs
      }
      startXRef.current = e.clientX;
      setDragging(true);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (startXRef.current === null) return;
      const delta = e.clientX - startXRef.current;
      if (delta === 0) return;
      startXRef.current = e.clientX;
      // For the right-side divider, a rightward drag should SHRINK the
      // right pane (i.e. its width goes down). Caller asks for raw
      // pointer delta and applies the sign — passing it through here
      // keeps the math local to the divider's owner.
      onResize(side === "left" ? delta : -delta);
    },
    [onResize, side],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (startXRef.current === null) return;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      startXRef.current = null;
      setDragging(false);
    },
    [],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      data-testid={`leader-fullscreen-divider-${side}`}
      data-no-drag
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset?.();
      }}
      style={{
        width: 5,
        cursor: "col-resize",
        background: dragging ? "var(--accent)" : "var(--border-default)",
        position: "relative",
        flexShrink: 0,
        transition: dragging ? "none" : "background 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!dragging)
          e.currentTarget.style.background = "var(--border-hover)";
      }}
      onMouseLeave={(e) => {
        if (!dragging)
          e.currentTarget.style.background = "var(--border-default)";
      }}
    >
      {/* Invisible hit-area extender (8px wider on each side) — easier
          to grab without changing the visual width. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          left: -4,
          right: -4,
          cursor: "col-resize",
        }}
      />
    </div>
  );
}
