import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";

interface ViewportOverlayProps {
  children: ReactNode;
  zIndex?: number;
  style?: CSSProperties;
}

/**
 * Fixed, non-scrolling overlay root for app chrome. Rendering through a
 * body-level portal keeps controls pinned to the visual viewport even if an
 * intermediate app pane or the document ever receives horizontal scroll.
 */
export function ViewportOverlay({
  children,
  zIndex = 900,
  style,
}: ViewportOverlayProps) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      data-viewport-overlay=""
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex,
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
