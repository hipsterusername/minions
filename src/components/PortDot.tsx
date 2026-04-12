import { useState, useCallback, useEffect, memo } from "react";

/**
 * Protocol-aware port colors — match the edge stroke colors in EdgeRenderer.
 */
export const PROTOCOL_COLORS: Record<string, string> = {
  "task-assignment": "var(--accent)",
  "task-status": "var(--edge-status)",
  "task-result": "var(--success-color)",
  context: "var(--accent)",
};

export type PortDirection = "input" | "output";

/** Information about a port, used during connection dragging */
export interface PortInfo {
  nodeId: string;
  portId: string;
  nodeType: string;
  direction: PortDirection;
  protocol: string;
}

interface PortDotProps {
  /** Which side the dot sits on: input = left, output = right */
  direction: PortDirection;
  /** Protocol determines color */
  protocol: string;
  /** Label shown on hover tooltip */
  label: string;
  /**
   * Vertical offset in pixels from the top of the parent.
   * Use the same math as EdgeRenderer: height / (portCount + 1) * (index + 1)
   */
  topPx: number;
  /** If true, show a locked/dimmed state (e.g. session already started) */
  locked?: boolean;
  /** Port identity — required for drag-to-connect */
  nodeId: string;
  portId: string;
  nodeType: string;
  /** Called when user starts dragging from this port */
  onConnectionStart?: (port: PortInfo, e: React.MouseEvent) => void;
  /** Called when user drops on this port (end of drag) */
  onConnectionEnd?: (port: PortInfo) => void;
  /** Whether a connection drag is currently in progress */
  isDragActive?: boolean;
  /** Whether this port is a valid drop target for the current drag */
  isValidTarget?: boolean;
  /** Whether the dragging cursor is currently snapping to this port */
  isSnapTarget?: boolean;
}

/**
 * A small circular port indicator rendered on the edge of a canvas node.
 *
 * Rendered at the CanvasNode level (outside the inner renderer) so it is
 * never clipped by `overflow: hidden` containers. Uses `data-no-drag` to
 * prevent the CanvasNode drag handler from capturing mousedowns on the dot.
 *
 * Parent must have `position: relative` (or absolute/fixed).
 */
// Inject CSS keyframe for snap pulse animation
const SNAP_PULSE_CSS = `
@keyframes portSnapPulse {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.4); opacity: 0.2; }
}
`;
let snapPulseStyleInjected = false;
function injectSnapPulseStyle() {
  if (snapPulseStyleInjected) return;
  snapPulseStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = SNAP_PULSE_CSS;
  document.head.appendChild(style);
}

export const PortDot = memo(function PortDot({
  direction,
  protocol,
  label,
  topPx,
  locked = false,
  nodeId,
  portId,
  nodeType,
  onConnectionStart,
  onConnectionEnd,
  isDragActive = false,
  isValidTarget = false,
  isSnapTarget = false,
}: PortDotProps) {
  const [hover, setHover] = useState(false);
  const color = PROTOCOL_COLORS[protocol] ?? "var(--text-muted)";

  const side = direction === "output" ? "right" : "left";

  // Inject CSS keyframe for snap pulse on first render
  useEffect(() => {
    injectSnapPulseStyle();
  }, []);

  // During active drag, highlight valid targets
  const showTargetHighlight = isDragActive && isValidTarget && hover;
  const effectiveOpacity = locked
    ? 0.25
    : isSnapTarget
      ? 1.0
      : showTargetHighlight
        ? 1.0
        : isDragActive && isValidTarget
          ? 0.8
          : hover
            ? 1.0
            : 0.5;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (locked) return;
      onConnectionStart?.(
        { nodeId, portId, nodeType, direction, protocol },
        e,
      );
    },
    [locked, nodeId, portId, nodeType, direction, protocol, onConnectionStart],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      onConnectionEnd?.({ nodeId, portId, nodeType, direction, protocol });
    },
    [locked, nodeId, portId, nodeType, direction, protocol, onConnectionEnd],
  );

  const dotSize = isSnapTarget ? 16 : isDragActive && isValidTarget ? 14 : 10;
  // Hit area is always larger than the visual dot for easier targeting
  const hitSize = Math.max(dotSize, 28);
  const hitOffset = -(hitSize / 2);

  return (
    <div
      data-no-drag
      data-port-id={portId}
      data-node-id={nodeId}
      data-port-direction={direction}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      title={locked ? `${label} (locked)` : label}
      style={{
        position: "absolute",
        [side]: hitOffset,
        top: topPx,
        transform: "translateY(-50%)",
        width: hitSize,
        height: hitSize,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
        cursor: locked ? "not-allowed" : "crosshair",
        pointerEvents: "auto",
      }}
    >
      {/* Snap pulse ring — appears when cursor is snapping to this port */}
      {isSnapTarget && (
        <div
          style={{
            position: "absolute",
            width: dotSize + 12,
            height: dotSize + 12,
            borderRadius: "50%",
            border: `2px solid ${color}`,
            animation: "portSnapPulse 0.8s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Visual dot */}
      <div
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: "50%",
          backgroundColor: color,
          opacity: effectiveOpacity,
          border: isSnapTarget
            ? `2px solid var(--text-primary)`
            : showTargetHighlight
              ? `2px solid var(--text-primary)`
              : "none",
          boxShadow: isSnapTarget
            ? `0 0 16px ${color}, 0 0 6px var(--text-primary)`
            : showTargetHighlight
              ? `0 0 12px ${color}, 0 0 4px var(--text-primary)`
              : hover && !locked
                ? `0 0 8px ${color}99`
                : isDragActive && isValidTarget
                  ? `0 0 6px ${color}66`
                  : "none",
          transition: "opacity 0.15s, box-shadow 0.15s, width 0.1s, height 0.1s",
          flexShrink: 0,
        }}
      />
    </div>
  );
});
