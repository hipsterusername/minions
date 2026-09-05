import { useState, useCallback, useEffect, useId, memo } from "react";
import "./port-dot.css";

/**
 * Protocol-aware port colors — match the edge stroke colors in EdgeRenderer.
 */
export const PROTOCOL_COLORS: Record<string, string> = {
  "task-assignment": "var(--accent)",
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
  locked?: boolean | undefined;
  /** Port identity — required for drag-to-connect */
  nodeId: string;
  portId: string;
  nodeType: string;
  /** Called when user starts dragging from this port */
  onConnectionStart?: ((port: PortInfo, e: React.MouseEvent) => void) | undefined;
  /** Called when user drops on this port (end of drag) */
  onConnectionEnd?: ((port: PortInfo) => void) | undefined;
  /** Whether a connection drag is currently in progress */
  isDragActive?: boolean | undefined;
  /** Whether this port is a valid drop target for the current drag */
  isValidTarget?: boolean | undefined;
  /** Whether the dragging cursor is currently snapping to this port */
  isSnapTarget?: boolean | undefined;
}

/**
 * A connection indicator rendered on the edge of a canvas node.
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
  const [focused, setFocused] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const tooltipId = useId();
  const isLeader = nodeType === "leader";
  const showHint = (hover || focused) && !isDragActive && !hintDismissed;
  const hint = !isLeader ? undefined : locked
    ? direction === "input" && protocol === "context"
      ? "Context is fixed after this session starts. Start a new session to change it."
      : "This connection is currently locked."
    : direction === "input"
      ? "Connect a context source here before starting the session."
      : protocol === "task-assignment"
        ? "Drag to a Minion’s task input to connect it to this leader."
        : "Drag to another leader’s context input to share this dashboard.";
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
  const hitSize = isLeader ? 32 : Math.max(dotSize, 28);
  const hitOffset = -(hitSize / 2);

  return (
    <div
      className={isLeader ? "leader-port" : undefined}
      data-state={isLeader ? locked ? "locked" : isSnapTarget ? "snap" : isDragActive && isValidTarget ? "target" : "rest" : undefined}
      data-no-drag
      data-port-id={portId}
      data-node-id={nodeId}
      data-port-direction={direction}
      tabIndex={isLeader ? 0 : undefined}
      role={isLeader ? "group" : undefined}
      aria-label={isLeader ? `${label} ${direction}${locked ? " (locked)" : ""}` : undefined}
      aria-describedby={showHint ? tooltipId : undefined}
      onMouseEnter={() => { setHover(true); setHintDismissed(false); }}
      onMouseLeave={() => setHover(false)}
      onFocus={() => { setFocused(true); setHintDismissed(false); }}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && showHint) {
          e.stopPropagation();
          setHintDismissed(true);
        }
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
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
      {isSnapTarget && !isLeader && (
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

      {isLeader ? (
        <svg className="leader-port__fins" viewBox="-4 -4 40 40" aria-hidden="true" style={{ color }}>
          {/* Both point right: into the card on the left, out on the right. */}
          <path className="leader-port__collar" d="M1 8V3h7M24 3h7v5M31 24v5h-7M8 29H1v-5" />
          <path className="leader-port__shell" d="M4 5h8l10 11-10 11H4l10-11z" />
          <path className="leader-port__fin" d="m17 5 10 11-10 11" />
          <path className="leader-port__core" d="m12 10 6 6-6 6 3-6z" />
          {locked && <g className="leader-port__lock"><rect x="22" y="22" width="9" height="8" rx="2" /><path d="M24 22v-2a2.5 2.5 0 0 1 5 0v2" /></g>}
        </svg>
      ) : <div
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
      />}

      {showHint && (
        <div
          id={tooltipId}
          role="tooltip"
          style={{
            position: "absolute",
            // For input ports (left side), show tooltip to the right of the dot;
            // for output ports (right side), show tooltip to the left.
            [direction === "input" ? "left" : "right"]: hitSize + 4,
            top: "50%",
            transform: "translateY(-50%)",
            padding: isLeader ? "8px 10px" : "4px 8px",
            borderRadius: "var(--radius-control, 4px)",
            backgroundColor: "var(--bg-tooltip, #1a1a1a)",
            color: "var(--text-primary, #fff)",
            fontSize: 11,
            fontWeight: 500,
            lineHeight: isLeader ? 1.5 : 1.2,
            whiteSpace: isLeader ? "normal" : "nowrap",
            width: isLeader ? 220 : undefined,
            border: isLeader ? "1px solid var(--border-hover)" : undefined,
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
            pointerEvents: "none",
            zIndex: 30,
            opacity: 0.95,
          }}
        >
          {locked ? `${label} (locked)` : label}
          {hint && <span className="leader-port__hint">{hint}</span>}
        </div>
      )}
    </div>
  );
});
