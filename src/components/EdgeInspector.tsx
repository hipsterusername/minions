/**
 * EdgeInspector — floating panel that appears near a selected graph edge.
 *
 * Lives inside Canvas's main container (NOT in world-space transform), so
 * its size stays constant at all zoom levels. The caller computes the
 * screen-space coordinates of the edge midpoint and passes them in.
 *
 * Actions available: delete the connection, focus its source node, focus
 * its target node, close the inspector. Designed to be invoked by clicking
 * an edge in EdgeRenderer; the Delete key short-circuits to onDelete.
 */
import type { GraphEdge } from "../graph.ts";
import type { ContextEdgeMode } from "../leader-context-mode.ts";
import type { EdgeContextStaleness } from "../context-staleness.ts";

const MODE_LABELS: Record<ContextEdgeMode, string> = {
  dashboard: "Dashboard",
  lean: "Lean",
  full: "Full",
};

export const MODE_HINTS: Record<ContextEdgeMode, string> = {
  dashboard: "Forward only this leader's dashboard (default).",
  lean: "Forward user inputs + responses. No thinking, no tool calls.",
  full: "Forward inputs + thinking + responses. No tool calls.",
};

const MODE_ORDER: ContextEdgeMode[] = ["dashboard", "lean", "full"];

function formatRelative(ms: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - ms) / 1_000));
  if (elapsedSeconds < 60) return "just now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function describeDelivery(staleness: EdgeContextStaleness): string {
  if (staleness.deliveredAt == null) {
    return "Not yet delivered · sent with your next message";
  }
  if (!staleness.stale) {
    return `Up to date · delivered ${formatRelative(staleness.deliveredAt)}`;
  }
  if (staleness.pendingBlocks != null && staleness.pendingBlocks > 0) {
    return `${staleness.pendingBlocks} new ${staleness.pendingBlocks === 1 ? "turn" : "turns"} upstream · sent with your next message`;
  }
  return "Changed upstream · sent with your next message";
}

interface EdgeInspectorProps {
  edge: GraphEdge;
  /** Screen-space x of the edge midpoint, relative to the canvas container. */
  screenX: number;
  /** Screen-space y of the edge midpoint, relative to the canvas container. */
  screenY: number;
  /** Human-readable label for the source node (used in body copy). */
  sourceLabel: string;
  /** Human-readable label for the target node. */
  targetLabel: string;
  onDelete: () => void;
  onFocusSource: () => void;
  onFocusTarget: () => void;
  onClose: () => void;
  /**
   * When present, renders the leader→leader context-forwarding mode control.
   * Canvas passes this only for leader→leader `context` edges.
   */
  contextMode?:
    | { current: ContextEdgeMode; onChange: (mode: ContextEdgeMode) => void }
    | undefined;
  staleness?: EdgeContextStaleness | null | undefined;
}

export function EdgeInspector({
  edge,
  screenX,
  screenY,
  sourceLabel,
  targetLabel,
  onDelete,
  onFocusSource,
  onFocusTarget,
  onClose,
  contextMode,
  staleness,
}: EdgeInspectorProps) {
  // Approximate panel size for centering; the actual width grows with the
  // labels but the offset is good enough that the panel always sits above
  // the edge midpoint.
  const PANEL_HALF_WIDTH = 110;
  const PANEL_OFFSET_Y = 18;

  return (
    <div
      role="dialog"
      aria-label="Edge inspector"
      data-testid="edge-inspector"
      onMouseDown={(e) => {
        // Stop the canvas's background mousedown from clearing the selection
        // when interacting with the inspector itself.
        e.stopPropagation();
      }}
      style={{
        position: "absolute",
        left: screenX - PANEL_HALF_WIDTH,
        top: screenY - PANEL_OFFSET_Y - 56,
        minWidth: 220,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 8,
        boxShadow: "var(--shadow-lg)",
        padding: "8px 10px",
        zIndex: 800,
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            fontSize: 10,
          }}
        >
          <span>{edge.protocol}</span>
          <span aria-hidden>•</span>
          <span>
            {sourceLabel} → {targetLabel}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 2,
            lineHeight: 1,
            fontSize: 14,
          }}
        >
          ×
        </button>
      </div>
      {contextMode && (
        <div
          data-testid="edge-inspector-mode"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              fontFamily: "var(--font-mono)",
            }}
          >
            Context passed downstream
          </div>
          <div
            role="group"
            aria-label="Context mode"
            style={{
              display: "inline-flex",
              alignSelf: "flex-start",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {MODE_ORDER.map((m) => {
              const active = contextMode.current === m;
              return (
                <button
                  key={m}
                  type="button"
                  data-testid={`edge-inspector-mode-${m}`}
                  aria-pressed={active}
                  title={MODE_HINTS[m]}
                  onClick={() => contextMode.onChange(m)}
                  style={{
                    background: active ? "var(--accent)" : "transparent",
                    color: active
                      ? "var(--accent-fg, #ffffff)"
                      : "var(--text-primary)",
                    border: "none",
                    borderRight:
                      m === "full" ? "none" : "1px solid var(--border-default)",
                    padding: "4px 10px",
                    fontSize: 11,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {MODE_LABELS[m]}
                </button>
              );
            })}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
            {MODE_HINTS[contextMode.current]}
          </div>
        </div>
      )}
      {staleness && (
        <div
          data-testid="edge-inspector-delivery"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            fontSize: 10,
          }}
        >
          <span
            style={{
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              fontFamily: "var(--font-mono)",
            }}
          >
            Delivery
          </span>
          <span
            style={{
              color: staleness.stale
                ? "var(--warning, #f59e0b)"
                : "var(--text-muted)",
            }}
          >
            {describeDelivery(staleness)}
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onDelete}
          data-testid="edge-inspector-delete"
          style={{
            background: "var(--danger-bg, rgba(239, 68, 68, 0.12))",
            color: "var(--danger-color, #ef4444)",
            border: "1px solid var(--danger-color, rgba(239, 68, 68, 0.3))",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Delete connection
        </button>
        <button
          type="button"
          onClick={onFocusSource}
          data-testid="edge-inspector-focus-source"
          style={{
            background: "transparent",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Focus source
        </button>
        <button
          type="button"
          onClick={onFocusTarget}
          data-testid="edge-inspector-focus-target"
          style={{
            background: "transparent",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Focus target
        </button>
      </div>
    </div>
  );
}
