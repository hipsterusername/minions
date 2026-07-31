import {
  memo,
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type Dispatch,
  type FormEvent,
} from "react";
import type { CanvasTransform, CanvasNode, CanvasAction, Position, Size, ContextItem } from "./types.ts";
import { MINION_THINKING_CONFIG } from "./types.ts";
import { generateId } from "./canvas-state.ts";
import { CanvasNodeComponent } from "./CanvasNode.tsx";
import { getAllNodeTypes, getUserCreatableNodeTypes, isContextProvider } from "./node-registry.ts";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette.tsx";
import { extractContextItem } from "./context-extraction.ts";
import {
  resolveLeaderContextItem,
  resolveContextMode,
  CONTEXT_MODE_MENU_OPTIONS,
} from "./leader-context-mode.ts";
import type { ContextEdgeMode } from "./leader-context-mode.ts";
import { useStableNodeGetter } from "./use-stable-node-getter.ts";
import { SessionPanel } from "./SessionPanel.tsx";
import { subscribeSocketTopics, type SocketSubscribe } from "./use-socket.ts";
import { EdgeRenderer } from "./EdgeRenderer.tsx";
import type { GraphDocument } from "./graph.ts";
import { getContract, canConnect, isPortOpen, LEADER_CONTRACT } from "./graph.ts";
import type { GraphAction } from "./graph-runtime.ts";
import { createEdge } from "./graph-runtime.ts";
import type { PortInfo } from "./components/PortDot.tsx";
import { PROTOCOL_COLORS } from "./components/PortDot.tsx";
import type { LeaderData, TaskPlanItem } from "./nodes/LeaderNode.tsx";
import { canvasDetachCommand } from "./nodes/leader/work-item.ts";
import { requestLeaderInputFocus } from "./leader-focus-request.ts";
import type { MinionData, MinionTaskState } from "./nodes/MinionNode.tsx";
import type { PermissionMode } from "./components/SessionToolbar.tsx";
import { sessionTopic } from "../shared/ws-envelope.ts";
import { CanvasContextMenu } from "./components/CanvasContextMenu.tsx";
import type { ContextMenuOption } from "./components/CanvasContextMenu.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { NodeStatusOverlay } from "./components/NodeStatusOverlay.tsx";
import { ViewportOverlay } from "./components/ViewportOverlay.tsx";
import { EdgeInspector } from "./components/EdgeInspector.tsx";
import { findContextEdgeStaleness } from "./context-staleness.ts";
import { CanvasMiniMap } from "./CanvasMiniMap.tsx";
import { applyPromptSeed, createDefaultNodeData } from "./node-defaults.ts";
import { wheelDetector, wheelZoomFactor } from "./wheel-detector.ts";
import { canvasScale as canvasScaleRef } from "./canvas-scale.ts";
import { useCanvasKeyboard } from "./use-canvas-keyboard.ts";
import { useCanvasFileDrop } from "./use-canvas-file-drop.ts";
import { agentSpawnDedupKey, claimSpawnEvent } from "./canvas/spawn-event.ts";
import { useSuppressMiddleClickPaste } from "./use-suppress-middle-click-paste.ts";
import { createImageNodeFromFile } from "./nodes/image-node-factory.ts";
import { createMarkdownNodeFromText } from "./nodes/markdown-node-factory.ts";
import { ABOVE_TOP_GAP, findNonOverlappingPosition, placeAboveTopNode, viewportCenter, snapToGrid, resolveTidyDrop, shouldRelocateOnDrop, centerTransformOnRect, focusTransformOnRects, didReposition } from "./canvas-utils.ts";
import { computeAutoLayout } from "./auto-layout.ts";
import { cloneLeaderContextEdges, cloneLeaderSetupData } from "./leader-setup-clone.ts";
import {
  applyPresetToLeaderData,
  captureLeaderPreset,
  type LeaderPreset,
} from "./leader-preset.ts";
import { decideConnectionDropAction } from "./connection-drop-decision.ts";
import {
  buildEmptyCanvasLeaderPrompt,
  isValidEmptyCanvasDescription,
} from "./empty-canvas.ts";
import { LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD } from "./nodes/leader/types.ts";
import { browserLogger } from "./logging.ts";
import { CanvasBackground } from "./CanvasBackground.tsx";

const log = browserLogger.child("canvas");

// Zoom-out floor: ~15% keeps the canvas readable at overview level.
const MIN_ZOOM = 0.15;

/** Height of the context-group title bar (also used by isInsideGroup). */
const GROUP_HEADER = 36;

/**
 * Check if a node belongs inside a group.  Uses the top-center of the
 * node rather than the geometric center so that tall nodes (e.g. expanded
 * file viewers at 420px) are still detected even when the group hasn't
 * resized to fit them yet.
 */
function isInsideGroup(node: CanvasNode, group: CanvasNode): boolean {
  const cx = node.position.x + node.size.width / 2;
  // Use a point near the top of the node — clamped so very short nodes
  // still use their center.
  const cy = node.position.y + Math.min(node.size.height / 2, GROUP_HEADER);
  return (
    cx >= group.position.x &&
    cx <= group.position.x + group.size.width &&
    cy >= group.position.y &&
    cy <= group.position.y + group.size.height
  );
}
// Zoom-in ceiling: ~2× keeps a single leader node (560×520) roughly
// viewport-sized without blowing past it into unusable territory.
const MAX_ZOOM = 2;

/** Snap radius in world-space units — connections complete automatically when
 *  the cursor comes this close to a valid target port. */
const SNAP_RADIUS = 50;

/** Stable empty Set shared across renders to avoid breaking React.memo
 *  comparisons when no connection drag is active. */
const EMPTY_VALID_TARGETS: Set<string> = new Set();

/** Compute the world-space centre position of a port on a node.
 *  Uses the same spacing math as EdgeRenderer and the drag preview. */
function getPortWorldPos(
  node: { position: Position; size: Size; type: string },
  portId: string,
  direction: "input" | "output",
): { x: number; y: number } | null {
  const contract = getContract(node.type);
  if (!contract) return null;
  const sameDirPorts = contract.ports.filter(
    (p) => p.direction === direction,
  );
  const idx = sameDirPorts.findIndex((p) => p.id === portId);
  if (idx === -1) return null;
  const anchorY = sameDirPorts[idx]?.anchorY;
  const y =
    anchorY != null
      ? node.position.y + node.size.height * anchorY
      : node.position.y + (node.size.height / (sameDirPorts.length + 1)) * (idx + 1);
  const x =
    direction === "output"
      ? node.position.x + node.size.width
      : node.position.x;
  return { x, y };
}

function computeLeaderDropPlacement(
  worldX: number,
  worldY: number,
  existingNodes: CanvasNode[],
) {
  const leaderDef = getAllNodeTypes().find((td) => td.type === "leader");
  if (!leaderDef) return null;

  const rawX = worldX - leaderDef.defaultSize.width / 2;
  const rawY = worldY - leaderDef.defaultSize.height / 2;
  const position = findNonOverlappingPosition(
    rawX,
    rawY,
    leaderDef.defaultSize.width,
    leaderDef.defaultSize.height,
    existingNodes,
  );
  const size = { ...leaderDef.defaultSize };
  const targetPort =
    getPortWorldPos({ position, size, type: "leader" }, "context-in", "input") ??
    { x: position.x, y: position.y + size.height * 0.95 };

  return { leaderDef, position, size, targetPort };
}

type CreateNodeAnchor =
  | { kind: "world"; x: number; y: number }
  | { kind: "smart"; preferCursor: boolean }
  // Stack the new node above the current top-most card; falls back to the
  // viewport centre when the canvas is empty.
  | { kind: "above-top" };

function EmptyCanvasState({
  onStart,
}: {
  onStart: (description: string) => void;
}) {
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const canStart = isValidEmptyCanvasDescription(description);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (!canStart) return;
    onStart(description.trim());
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        padding: 24,
      }}
    >
      <form
        onSubmit={handleSubmit}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        style={{
          width: "min(560px, calc(100vw - 48px))",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 18,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          boxShadow: "var(--shadow-lg)",
          pointerEvents: "auto",
          fontFamily: "var(--font-sans)",
        }}
        aria-label="Start canvas with context"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 650,
              color: "var(--text-primary)",
              lineHeight: 1.3,
            }}
          >
            Start with context
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            Describe the project, goal, constraints, or current state before
            the Leader begins.
          </div>
        </div>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            Context description
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            rows={5}
            placeholder="Example: This repo is a canvas for coordinating agent work. I want to triage the next product improvements and keep a dashboard current."
            style={{
              width: "100%",
              resize: "vertical",
              minHeight: 112,
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              outline: "none",
              background: "var(--bg-primary)",
              color: "var(--text-primary)",
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: "19px",
              fontFamily: "var(--font-sans)",
            }}
          />
        </label>

        {submitted && !canStart && (
          <div
            role="alert"
            style={{
              fontSize: 11,
              color: "var(--status-warning)",
              lineHeight: 1.4,
            }}
          >
            Add a bit more context before starting.
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.4,
            }}
          >
            The Leader will create and refresh the dashboard as it works.
          </span>
          <button
            type="submit"
            disabled={!canStart}
            style={{
              flexShrink: 0,
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              background: canStart ? "var(--accent)" : "var(--bg-elevated)",
              color: canStart ? "#000" : "var(--text-muted)",
              cursor: canStart ? "pointer" : "default",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
            }}
          >
            Start Leader
          </button>
        </div>
      </form>
    </div>
  );
}

interface ToolbarProps {
  transform: CanvasTransform;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFitView: () => void;
  onFocusSelected: () => void;
  hasSelection: boolean;
  onAddNode: (type: string) => void;
  onTidyLayout: () => void;
  onFocusNextActive: () => void;
  hasActiveNodes: boolean;
}

const Toolbar = memo(function Toolbar({
  transform,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitView,
  onFocusSelected,
  hasSelection,
  onAddNode,
  onTidyLayout,
  onFocusNextActive,
  hasActiveNodes,
}: ToolbarProps) {
  const btnStyle: React.CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: 6,
    border: "1px solid var(--border-default)",
    background: "var(--bg-surface)",
    color: "var(--text-secondary)",
    fontSize: 14,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 4,
        padding: 6,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 100,
        alignItems: "center",
        pointerEvents: "auto",
      }}
    >
      <button
        style={{
          ...btnStyle,
          background: "var(--accent)",
          color: "#000",
          border: "none",
        }}
        onClick={() => onAddNode("leader")}
        title="Add Leader node"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 40 40"
          fill="none"
        >
          {/* Crown-in-circle leader icon — circle is the eye socket,
              crown + dot are the leader glyph (matches LeaderLoadingScreen). */}
          <circle cx="20" cy="20" r="16" fill="rgba(255,255,255,0.25)" stroke="currentColor" strokeWidth="2"/>
          <path d="M12 24L10 16L16 20L20 14L24 20L30 16L28 24H12Z" fill="currentColor"/>
          <circle cx="20" cy="28" r="2" fill="currentColor"/>
        </svg>
      </button>
      <button
        style={{
          ...btnStyle,
          background: "var(--bg-surface)",
          color: "var(--text-secondary)",
        }}
        onClick={() => onAddNode("markdown")}
        title="Add Markdown node"
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-elevated)";
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--bg-surface)";
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Document with lines */}
          <path d="M4 1.5h5l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" />
          <path d="M9 1.5v4h4" />
          <line x1="5.5" y1="8" x2="10.5" y2="8" />
          <line x1="5.5" y1="10.5" x2="10.5" y2="10.5" />
          <line x1="5.5" y1="13" x2="8" y2="13" />
        </svg>
      </button>

      <div
        style={{
          width: 1,
          height: 20,
          background: "var(--border-default)",
          margin: "0 4px",
        }}
      />

      <button style={btnStyle} onClick={onZoomOut} title="Zoom out">
        -
      </button>
      <button
        style={{
          ...btnStyle,
          width: "auto",
          padding: "0 8px",
          fontSize: 11,
        }}
        onClick={onZoomReset}
        title="Reset zoom"
      >
        {Math.round(transform.scale * 100)}%
      </button>
      <button style={btnStyle} onClick={onZoomIn} title="Zoom in">
        +
      </button>
      <button
        style={{ ...btnStyle, fontSize: 11 }}
        onClick={onFitView}
        title="Fit view"
      >
        []
      </button>
      <button
        style={{
          ...btnStyle,
          fontSize: 11,
          opacity: hasSelection ? 1 : 0.4,
          cursor: hasSelection ? "pointer" : "default",
        }}
        onClick={hasSelection ? onFocusSelected : undefined}
        title="Focus selected node (F)"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Crosshair / target icon */}
          <circle cx="8" cy="8" r="5" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
          <line x1="8" y1="1" x2="8" y2="3" />
          <line x1="8" y1="13" x2="8" y2="15" />
          <line x1="1" y1="8" x2="3" y2="8" />
          <line x1="13" y1="8" x2="15" y2="8" />
        </svg>
      </button>
      <button
        style={{
          ...btnStyle,
          fontSize: 11,
          opacity: hasActiveNodes ? 1 : 0.4,
          cursor: hasActiveNodes ? "pointer" : "default",
          ...(hasActiveNodes
            ? { color: "var(--accent)", borderColor: "var(--accent)" }
            : {}),
        }}
        onClick={hasActiveNodes ? onFocusNextActive : undefined}
        title="Focus next active node (N)"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Animated-style target with arrow: cycle through active nodes */}
          <circle cx="8" cy="8" r="5" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
          <polyline points="12,4 14,2 14,5 11,5" strokeWidth="1.5" />
        </svg>
      </button>

      <div
        style={{
          width: 1,
          height: 20,
          background: "var(--border-default)",
          margin: "0 4px",
        }}
      />

      <button
        style={{ ...btnStyle, fontSize: 11 }}
        onClick={onTidyLayout}
        title="Auto-arrange nodes"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        >
          {/* Leader */}
          <rect x="4" y="0.5" width="6" height="4" rx="1" />
          {/* Connector line down */}
          <line x1="7" y1="4.5" x2="7" y2="6.5" />
          {/* Minion row */}
          <line x1="2.5" y1="6.5" x2="11.5" y2="6.5" />
          <line x1="2.5" y1="6.5" x2="2.5" y2="7.5" />
          <line x1="7" y1="6.5" x2="7" y2="7.5" />
          <line x1="11.5" y1="6.5" x2="11.5" y2="7.5" />
          <rect x="0.5" y="7.5" width="4" height="3" rx="0.8" />
          <rect x="4.75" y="7.5" width="4.5" height="3" rx="0.8" />
          <rect x="9.5" y="7.5" width="4" height="3" rx="0.8" />
        </svg>
      </button>
    </div>
  );
});

interface CanvasProps {
  nodes: CanvasNode[];
  dispatch: Dispatch<CanvasAction>;
  graph: GraphDocument;
  graphDispatch: Dispatch<GraphAction>;
  transform: CanvasTransform;
  setTransform: React.Dispatch<React.SetStateAction<CanvasTransform>>;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: SocketSubscribe;
  socketConnected?: boolean;
  projectPath?: string;
  projectId?: string;
  projectSettings?: import("./api.ts").ProjectSettings;
  onProjectSettingsChange?: (settings: import("./api.ts").ProjectSettings) => void;
  undo?: () => void;
  redo?: () => void;
  /** When set, auto-selects this node (then clear it) */
  focusNodeId?: string | null;
  onFocusNodeHandled?: () => void;
  viewportTopOffset?: number;
}

export function Canvas({
  nodes,
  dispatch,
  graph,
  graphDispatch,
  transform,
  setTransform,
  socketSend,
  socketSubscribe,
  socketConnected,
  projectPath,
  projectId,
  projectSettings,
  onProjectSettingsChange,
  undo,
  redo,
  focusNodeId,
  onFocusNodeHandled,
  viewportTopOffset = 0,
}: CanvasProps) {
  // Keep the module-level scale ref in sync so CanvasNode / ResizeHandle
  // can read the current zoom in event handlers without a prop (which would
  // bust React.memo on every node each zoom frame).
  canvasScaleRef.current = transform.scale;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Edge selection is separate from node selection: clicking an edge selects
  // exactly one edge and clears node selection (and vice versa). Hover is
  // tracked independently so the inspector can preview which edge would be
  // selected.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // ── Marquee (rectangle) selection state ──
  const [marquee, setMarquee] = useState<{
    /** Starting point in screen coordinates */
    startX: number; startY: number;
    /** Current point in screen coordinates */
    currentX: number; currentY: number;
  } | null>(null);

  // ── Context menu state ────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{
    /** Screen position */
    screenX: number;
    screenY: number;
    /** World position for placing the node */
    worldX: number;
    worldY: number;
  } | null>(null);

  const contextMenuOptions: ContextMenuOption[] = useMemo(
    () =>
      getUserCreatableNodeTypes().map((def) => ({
        label: `New ${def.label}`,
        type: def.type,
      })),
    [],
  );

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandPaletteItems = useMemo<PaletteItem[]>(
    () => [
      ...getUserCreatableNodeTypes().map((def) => ({
        kind: "node",
        type: def.type,
        label: `New ${def.label}`,
      }) satisfies PaletteItem),
      ...(projectSettings?.leaderPresets ?? []).map((preset) => ({
        kind: "preset",
        id: preset.id,
        label: preset.name,
        ...(preset.description ? { description: preset.description } : {}),
      }) satisfies PaletteItem),
    ],
    [projectSettings?.leaderPresets],
  );

  // The dashboard output port menu lists the three context-forwarding modes.
  // Selecting one spawns a connected leader and stamps the chosen mode onto
  // the new context edge. (The former context 'shortcuts' — named leader
  // actions, fanout, custom — are deferred; the configurable Context Actions
  // now live in the Leader slash menu, driven by dashboard-leader-actions.ts.)
  const dashboardDropMenuOptions: ContextMenuOption[] = useMemo(
    () => CONTEXT_MODE_MENU_OPTIONS.map((o) => ({ label: o.label, type: o.type })),
    [],
  );

  const [dashboardDropMenu, setDashboardDropMenu] = useState<{
    screenX: number;
    screenY: number;
    worldX: number;
    worldY: number;
    source: PortInfo;
    compatiblePortId: string;
    placement: NonNullable<ReturnType<typeof computeLeaderDropPlacement>>;
  } | null>(null);

  // ── Connection drag state ─────────────────────────────
  const [connectionDrag, setConnectionDrag] = useState<{
    source: PortInfo;
    /** Current mouse position in canvas (world) coordinates */
    mouseX: number;
    mouseY: number;
    /** Nearest valid port within SNAP_RADIUS, or null */
    snapTarget: PortInfo | null;
  } | null>(null);

  /** Ref mirror of connectionDrag.snapTarget — readable inside event closures
   *  without stale-closure issues. */
  const snapTargetRef = useRef<PortInfo | null>(null);

  /** Set when a port-level mouseup consumes a connection drop. */
  const connectionHandledByPortRef = useRef(false);

  /** Ref mirror of connectionDrag — lets handleConnectionEnd stay stable. */
  const connectionDragRef = useRef(connectionDrag);
  connectionDragRef.current = connectionDrag;

  /** Set of "nodeId:portId" strings that are valid drop targets */
  const [validTargets, setValidTargets] = useState<Set<string>>(EMPTY_VALID_TARGETS);

  /** Set of "nodeId:portId" strings for all ports that have at least one edge connected */
  const connectedPorts = useMemo(() => {
    const s = new Set<string>();
    for (const e of graph.edges) {
      s.add(`${e.sourceNodeId}:${e.sourcePortId}`);
      s.add(`${e.targetNodeId}:${e.targetPortId}`);
    }
    return s;
  }, [graph.edges]);

  /** Set of node IDs that are spatially inside a context-group. */
  const nodesInsideGroups = useMemo(() => {
    const groups = nodes.filter((n) => n.type === "context-group");
    if (groups.length === 0) return new Set<string>();
    const s = new Set<string>();
    for (const n of nodes) {
      if (n.type === "context-group") continue;
      for (const g of groups) {
        if (isInsideGroup(n, g)) { s.add(n.id); break; }
      }
    }
    return s;
  }, [nodes]);

  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ startX: number; startY: number } | null>(null);
  const spaceRef = useRef(false);
  const lastCanvasPointerRef = useRef<{
    worldX: number;
    worldY: number;
    overEmptyCanvas: boolean;
    at: number;
  } | null>(null);
  const recentActiveLeaderIdRef = useRef<string | null>(null);

  // ── Node drag tracking (for context-group drop feedback) ──
  /** Which node is currently being dragged by the user, null when idle */
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const draggingNodeIdRef = useRef<string | null>(null);
  /** World-space position of the dragged node when the drag began — used to
   *  decide whether a drop repositioned it far enough to recenter the camera. */
  const dragStartPosRef = useRef<Position | null>(null);
  /** rAF handle for an in-flight camera pan tween, null when idle. */
  const cameraAnimRef = useRef<number | null>(null);
  /** Which context-group is the current drop target, null when none */
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const dropTargetGroupIdRef = useRef<string | null>(null);
  dropTargetGroupIdRef.current = dropTargetGroupId;

  /** Pending context-group deletion: shows confirmation modal */
  const [pendingGroupDelete, setPendingGroupDelete] = useState<{
    groupIds: string[];
    containedIds: string[];
    /** Other non-group IDs that were also selected */
    otherIds: string[];
  } | null>(null);

  /** Context-compatible node types that can be dropped into groups */
  const DROPPABLE_TYPES = useMemo(() => new Set(["markdown", "note", "file-viewer"]), []);

  /** Snapshot of node IDs contained in each dragging context-group at drag start.
   *  Keyed by context-group node ID. Used to prevent groups from "latching"
   *  onto unrelated nodes they pass over during the drag. */
  const dragGroupContainedIdsRef = useRef<Map<string, Set<string>>>(new Map());

  // ── Pending minion spawn tracking ──
  interface PendingMinionSpawn {
    leaderNodeId: string;
    minionSessionKey: string | null;
    taskId: string;
    title: string;
    description: string;
    priority: "low" | "medium" | "high" | "critical";
    worktreeBranch?: string | null | undefined;
    model?: string | null | undefined;
    harness?: string | null | undefined;
    permissionMode?: PermissionMode | undefined;
    isAgent?: boolean | undefined;
    parentSessionKey?: string | undefined;
  }
  const pendingMinionsRef = useRef<Map<string, PendingMinionSpawn>>(new Map());
  const revealedMinionsRef = useRef<Set<string>>(new Set());
  const spawnedMinionsRef = useRef<Set<string>>(new Set());

  /** Cancel any in-flight camera pan tween so user input takes over cleanly. */
  const cancelCameraAnim = useCallback(() => {
    if (cameraAnimRef.current != null) {
      cancelAnimationFrame(cameraAnimRef.current);
      cameraAnimRef.current = null;
    }
  }, []);

  /**
   * Smoothly tween the viewport transform from its current value to `target`
   * over `durationMs` using an ease-out curve. Interrupts any prior tween.
   * Used to glide the camera onto a node's new placement after a drag.
   */
  const animateTransformTo = useCallback(
    (target: CanvasTransform, durationMs = 260) => {
      cancelCameraAnim();
      const start = transformRef.current;
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const ds = target.scale - start.scale;
      if (dx === 0 && dy === 0 && ds === 0) return;
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      let startTs: number | null = null;
      const step = (ts: number) => {
        if (startTs == null) startTs = ts;
        const t = durationMs <= 0 ? 1 : Math.min(1, (ts - startTs) / durationMs);
        const e = easeOutCubic(t);
        setTransform({
          x: start.x + dx * e,
          y: start.y + dy * e,
          scale: start.scale + ds * e,
        });
        cameraAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      cameraAnimRef.current = requestAnimationFrame(step);
    },
    [cancelCameraAnim, setTransform],
  );

  /**
   * Pan the camera to center a node placement, preserving the current zoom.
   * A missing start position means this is a newly-created placement and
   * should always be followed.
   */
  const recenterCameraOnPlacement = useCallback(
    (startPos: Position | null, endPos: Position | null, size: Size | null) => {
      const container = containerRef.current;
      if (!container || !endPos || !size) return;
      if (startPos && !didReposition(startPos, endPos)) return;
      const target = centerTransformOnRect(
        { x: endPos.x, y: endPos.y, width: size.width, height: size.height },
        { width: container.clientWidth, height: container.clientHeight },
        transformRef.current.scale,
      );
      animateTransformTo(target);
    },
    [animateTransformTo],
  );

  // Cancel any running camera tween on unmount to avoid setState-after-unmount.
  useEffect(() => cancelCameraAnim, [cancelCameraAnim]);

  const handleDragStart = useCallback((nodeId: string) => {
    draggingNodeIdRef.current = nodeId;
    setDraggingNodeId(nodeId);
    // Starting a new drag interrupts any in-flight camera glide, and records
    // where this node began so drag-end can tell if it was actually moved.
    cancelCameraAnim();
    const startNode = nodesRef.current.find((n) => n.id === nodeId);
    dragStartPosRef.current = startNode ? { ...startNode.position } : null;

    // Snapshot: record which nodes are inside each context-group that is
    // part of this drag (the directly-dragged node AND any other selected
    // context-groups). This prevents groups from "latching" onto unrelated
    // nodes they pass over mid-drag.
    const snapshotMap = new Map<string, Set<string>>();

    // Collect all context-group IDs involved in this drag
    const groupIdsToSnapshot = new Set<string>();
    const draggedNode = nodesRef.current.find((n) => n.id === nodeId);
    if (draggedNode?.type === "context-group") {
      groupIdsToSnapshot.add(nodeId);
    }
    // If multi-selecting, include any other selected context-groups
    const sel = selectedIdsRef.current;
    if (sel.has(nodeId) && sel.size > 1) {
      for (const selId of sel) {
        const selNode = nodesRef.current.find((n) => n.id === selId);
        if (selNode?.type === "context-group") {
          groupIdsToSnapshot.add(selId);
        }
      }
    }

    for (const gId of groupIdsToSnapshot) {
      const groupNode = nodesRef.current.find((n) => n.id === gId);
      if (!groupNode) continue;
      const ids = new Set<string>();
      for (const n of nodesRef.current) {
        if (n.id === gId || n.type === "context-group") continue;
        if (isInsideGroup(n, groupNode)) ids.add(n.id);
      }
      snapshotMap.set(gId, ids);
    }

    dragGroupContainedIdsRef.current = snapshotMap;
  }, [isInsideGroup, cancelCameraAnim]);

  const handleDragEnd = useCallback((nodeId: string) => {
    const targetGroupId = dropTargetGroupIdRef.current;
    draggingNodeIdRef.current = null;
    dragGroupContainedIdsRef.current = new Map();
    setDraggingNodeId(null);
    setDropTargetGroupId(null);

    const startPos = dragStartPosRef.current;
    dragStartPosRef.current = null;
    const draggedNode = nodesRef.current.find((n) => n.id === nodeId);

    // Resolve the node's final placement after any drop-snapping. The branches
    // mirror the original drop logic (group snap, tidy relocation, free drop)
    // and each returns where the node ends up, so the camera can follow it.
    const resolveFinalPosition = (): Position | null => {
      if (!draggedNode) return null;

      // If the visual drop target was active, snap the node so its center
      // lands inside the group. The existing restack effect (debounced) will
      // then arrange it in the proper stacked layout.
      if (targetGroupId) {
        const group = nodesRef.current.find((n) => n.id === targetGroupId);
        if (group) {
          // Check if the center already falls inside the group (no snap needed)
          const cx = draggedNode.position.x + draggedNode.size.width / 2;
          const cy = draggedNode.position.y + draggedNode.size.height / 2;
          const alreadyInside =
            cx >= group.position.x &&
            cx <= group.position.x + group.size.width &&
            cy >= group.position.y &&
            cy <= group.position.y + group.size.height;

          if (!alreadyInside) {
            // Snap: center horizontally within the group, place below
            // the header with padding so the restack has a clean starting point.
            const snapX = group.position.x + (group.size.width - draggedNode.size.width) / 2;
            const snapY = group.position.y + 36 + 16; // GROUP_HEADER + GROUP_PAD
            dispatch({ type: "MOVE_NODE", id: nodeId, position: { x: snapX, y: snapY } });
            return { x: snapX, y: snapY };
          }
        }
        return { ...draggedNode.position };
      }

      // ── Tidy layout: snap the dropped node/cluster flush to its neighbour ──
      // When tidy layout is on, a node dropped so it overlaps another snaps flush
      // against that neighbour — on the side nearest where it was dropped
      // (right/left share the top edge, top/bottom share the left edge) with a
      // small gutter — so nodes never overlap. Free drops just snap to the grid.
      // Leaders carry their minions and dashboards as one cluster. Context-groups
      // (frames that intentionally contain overlapping nodes) and multi-select
      // drags (a deliberate manual arrangement) are left alone.
      if (projectSettingsRef.current?.tidyLayout === false) {
        return { ...draggedNode.position };
      }
      const isMultiSelect =
        selectedIdsRef.current.has(nodeId) && selectedIdsRef.current.size > 1;
      if (!shouldRelocateOnDrop(draggedNode, isMultiSelect)) {
        return { ...draggedNode.position };
      }

      const movers: CanvasNode[] = [draggedNode];
      if (draggedNode.type === "leader") {
        for (const n of nodesRef.current) {
          if (n.type === "minion" && (n.data as MinionData).leaderId === draggedNode.id) {
            movers.push(n);
          }
        }
      }
      const moverIds = new Set(movers.map((m) => m.id));
      // Context-group frames are containers, not obstacles.
      const obstacles = nodesRef.current.filter(
        (n) => !moverIds.has(n.id) && n.type !== "context-group",
      );
      const { dx, dy } = resolveTidyDrop(movers, obstacles);
      if (dx === 0 && dy === 0) return { ...draggedNode.position };
      dispatch({
        type: "MOVE_GROUP",
        moves: movers.map((m) => ({
          id: m.id,
          position: { x: m.position.x + dx, y: m.position.y + dy },
        })),
      });
      return { x: draggedNode.position.x + dx, y: draggedNode.position.y + dy };
    };

    // Follow the node to its new placement (pan only, preserves zoom).
    recenterCameraOnPlacement(startPos, resolveFinalPosition(), draggedNode?.size ?? null);
  }, [dispatch, recenterCameraOnPlacement]);

  // Keep refs to nodes, transform, and selection so callbacks can access latest
  // state without needing them in dependency arrays (which would defeat memoization).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const projectSettingsRef = useRef(projectSettings);
  projectSettingsRef.current = projectSettings;

  interface LeaderSetupClipboard {
    sourceNodeId: string;
    sourcePosition: Position;
    sourceSize: Size;
    data: LeaderData;
    contextEdges: GraphDocument["edges"];
  }

  const leaderSetupClipboardRef = useRef<LeaderSetupClipboard | null>(null);

  const createLeaderSetupClipboard = useCallback(
    (nodeId: string): LeaderSetupClipboard | null => {
      const source = nodesRef.current.find((n) => n.id === nodeId);
      if (!source || source.type !== "leader") return null;
      return {
        sourceNodeId: source.id,
        sourcePosition: { ...source.position },
        sourceSize: { ...source.size },
        data: cloneLeaderSetupData(source.data as LeaderData),
        contextEdges: graphRef.current.edges.filter(
          (edge) =>
            edge.targetNodeId === source.id &&
            edge.targetPortId === "context-in" &&
            edge.protocol === "context",
        ),
      };
    },
    [],
  );

  const pasteLeaderSetupClipboard = useCallback(
    (clipboard: LeaderSetupClipboard): boolean => {
      const leaderTypeDef = getAllNodeTypes().find((t) => t.type === "leader");
      if (!leaderTypeDef) return false;

      const newId = generateId();
      const rawX = clipboard.sourcePosition.x + 48;
      const rawY = clipboard.sourcePosition.y + 48;
      const position = findNonOverlappingPosition(
        rawX,
        rawY,
        clipboard.sourceSize.width,
        clipboard.sourceSize.height,
        nodesRef.current,
      );

      const node: CanvasNode = {
        id: newId,
        type: "leader",
        position,
        size: { ...clipboard.sourceSize },
        data: cloneLeaderSetupData(clipboard.data),
      };
      dispatch({ type: "ADD_NODE", node });

      const liveNodeIds = new Set(nodesRef.current.map((n) => n.id));
      for (const edge of cloneLeaderContextEdges(
        clipboard.contextEdges,
        clipboard.sourceNodeId,
        newId,
        () => `edge-${generateId()}`,
      )) {
        if (liveNodeIds.has(edge.sourceNodeId)) {
          graphDispatch({ type: "ADD_EDGE", edge });
        }
      }

      setSelectedIds(new Set([newId]));
      return true;
    },
    [dispatch, graphDispatch],
  );

  const copyLeaderSetup = useCallback((nodeId: string): boolean => {
    const clipboard = createLeaderSetupClipboard(nodeId);
    if (!clipboard) return false;
    leaderSetupClipboardRef.current = clipboard;
    return true;
  }, [createLeaderSetupClipboard]);

  const pasteLeaderSetup = useCallback((): boolean => {
    const clipboard = leaderSetupClipboardRef.current;
    if (!clipboard) return false;
    return pasteLeaderSetupClipboard(clipboard);
  }, [pasteLeaderSetupClipboard]);

  const duplicateLeaderSetup = useCallback((nodeId: string): void => {
    const clipboard = createLeaderSetupClipboard(nodeId);
    if (clipboard) {
      leaderSetupClipboardRef.current = clipboard;
      pasteLeaderSetupClipboard(clipboard);
    }
  }, [createLeaderSetupClipboard, pasteLeaderSetupClipboard]);

  // Open a System Model node beside a leader, preloaded with its session key.
  const openSystemModelForLeader = useCallback((nodeId: string): void => {
    const leader = nodesRef.current.find((n) => n.id === nodeId);
    const sessionKey = (leader?.data as { sessionKey?: string | null } | undefined)
      ?.sessionKey;
    if (!leader || !sessionKey) return;
    const typeDef = getAllNodeTypes().find((t) => t.type === "system-graph");
    if (!typeDef) return;
    const defaultData = createDefaultNodeData("system-graph") as Record<string, unknown>;
    dispatch({
      type: "ADD_NODE",
      node: {
        id: generateId(),
        type: "system-graph",
        position: {
          x: leader.position.x + leader.size.width + 48,
          y: leader.position.y,
        },
        size: { ...typeDef.defaultSize },
        data: { ...defaultData, sessionKey },
      },
    });
  }, [dispatch]);

  const saveLeaderPreset = useCallback(
    (
      nodeId: string,
      input: {
        name: string;
        description?: string;
        systemPromptPrefix?: string;
      },
    ): boolean => {
      if (!onProjectSettingsChange) return false;
      const source = nodesRef.current.find((n) => n.id === nodeId);
      if (!source || source.type !== "leader") return false;

      const name = input.name.trim();
      if (!name) return false;
      const description = input.description?.trim();
      const systemPromptPrefix = input.systemPromptPrefix?.trim();
      const now = new Date().toISOString();
      const preset = captureLeaderPreset(
        source.data as LeaderData,
        {
          id: `leader-preset-${generateId()}`,
          name,
          ...(description ? { description } : {}),
          ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
        },
        now,
      );
      const current = projectSettingsRef.current ?? {};
      onProjectSettingsChange({
        ...current,
        leaderPresets: [...(current.leaderPresets ?? []), preset],
      });
      return true;
    },
    [onProjectSettingsChange],
  );

  // Attach a backend session to the canvas by creating the right node type for its role
  const handleAttachSession = useCallback(
    (sessionKey: string, role?: "leader" | "minion" | "default") => {
      const nodeType = role === "leader" ? "leader" : role === "minion" ? "minion" : "claude-session";
      const typeDef = getAllNodeTypes().find((t) => t.type === nodeType);
      if (!typeDef) return;

      const container = containerRef.current;
      const centerX = container
        ? (container.clientWidth / 2 - transform.x) / transform.scale
        : 400;
      const centerY = container
        ? (container.clientHeight / 2 - transform.y) / transform.scale
        : 300;

      const defaultData = createDefaultNodeData(nodeType) as Record<string, unknown>;
      const sessionData = {
        ...defaultData,
        sessionKey,
        status: "idle",
      };

      dispatch({
        type: "ADD_NODE",
        node: {
          id: generateId(),
          type: nodeType,
          position: {
            x: centerX - typeDef.defaultSize.width / 2,
            y: centerY - typeDef.defaultSize.height / 2,
          },
          size: { ...typeDef.defaultSize },
          data: sessionData,
        },
      });
    },
    [transform, dispatch],
  );

  // Compute sessionKey -> nodeId map for sessions on the canvas (any node type with a sessionKey).
  // First occurrence wins if the same session is attached to multiple nodes.
  const sessionKeyToNodeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) {
      if (n.type !== "claude-session" && n.type !== "leader" && n.type !== "minion") continue;
      const key = (n.data as { sessionKey?: string | null }).sessionKey;
      if (key != null && !map.has(key)) {
        map.set(key, n.id);
      }
    }
    return map;
  }, [nodes]);

  const attachedSessionKeys = useMemo(
    () => new Set(sessionKeyToNodeId.keys()),
    [sessionKeyToNodeId],
  );

  /**
   * Focus on specific nodes: center viewport and zoom to a "goldilocks" level.
   * For a single node, picks a scale that shows the node with comfortable padding.
   * For multiple nodes, fits them all with padding.
   */
  const focusNodes = useCallback(
    (targetIds: Set<string>) => {
      if (targetIds.size === 0) return;
      const container = containerRef.current;
      if (!container) return;

      const targets = nodes.filter((n) => targetIds.has(n.id));
      if (targets.length === 0) return;

      const target = focusTransformOnRects(
        targets.map((node) => ({ ...node.position, ...node.size })),
        { width: container.clientWidth, height: container.clientHeight },
        { padding: 80, maxScale: 1 },
      );
      if (target) setTransform(target);
    },
    [nodes, setTransform],
  );

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      const ids = new Set([nodeId]);
      setSelectedEdgeId(null);
      setSelectedIds(ids);
      focusNodes(ids);
    },
    [focusNodes],
  );

  // Focus the canvas on the node hosting the given sessionKey (if any).
  const handleFocusSession = useCallback(
    (sessionKey: string) => {
      const nodeId = sessionKeyToNodeId.get(sessionKey);
      if (!nodeId) return;
      handleFocusNode(nodeId);
    },
    [sessionKeyToNodeId, handleFocusNode],
  );

  // ── Active nodes: leaders/minions with a live session ──
  // Includes running, idle, creating, and waiting — excludes disconnected/stopped/error
  const INACTIVE_STATUSES = new Set(["disconnected", "stopped", "error"]);
  const activeNodeIds = useMemo(() => {
    return nodes
      .filter((n) => {
        if (n.type === "leader") {
          const s = (n.data as LeaderData).status;
          return !INACTIVE_STATUSES.has(s) && (n.data as LeaderData).sessionKey != null;
        }
        if (n.type === "minion") {
          const s = (n.data as MinionData).status;
          return !INACTIVE_STATUSES.has(s) && (n.data as MinionData).sessionKey != null;
        }
        return false;
      })
      .map((n) => n.id);
  }, [nodes]);
  const activeNodeIdSet = useMemo(() => new Set(activeNodeIds), [activeNodeIds]);

  useEffect(() => {
    const activeLeader = nodes.find(
      (n) => n.type === "leader" && activeNodeIdSet.has(n.id),
    );
    if (activeLeader) recentActiveLeaderIdRef.current = activeLeader.id;
  }, [nodes, activeNodeIdSet]);

  // Track which active node we last focused, to cycle through them
  const lastActiveIndexRef = useRef(-1);

  const focusNextActive = useCallback(() => {
    if (activeNodeIds.length === 0) return;
    // Advance to the next active node (wrapping around)
    let nextIndex = lastActiveIndexRef.current + 1;
    if (nextIndex >= activeNodeIds.length) nextIndex = 0;
    lastActiveIndexRef.current = nextIndex;
    const id = activeNodeIds[nextIndex];
    if (!id) return;
    setSelectedIds(new Set([id]));
    focusNodes(new Set([id]));
  }, [activeNodeIds, focusNodes, setSelectedIds]);

  // Handle external focus-node requests — select AND zoom/center
  useEffect(() => {
    if (!focusNodeId) return;
    const ids = new Set([focusNodeId]);
    setSelectedIds(ids);
    focusNodes(ids);
    onFocusNodeHandled?.();
  }, [focusNodeId, onFocusNodeHandled, focusNodes]);

  // ── Reveal minion on demand ──
  // Called from the leader's task plan UI when the user clicks a minion task.
  // Creates the minion node if not already on the canvas, or scrolls to it.
  const revealMinion = useCallback(
    (minionSessionKey: string) => {
      // Already revealed? Scroll to the existing node.
      const existing = nodesRef.current.find(
        (n) =>
          n.type === "minion" &&
          ((n.data as MinionData).sessionKey === minionSessionKey ||
            (n.data as MinionData).agentTaskId === minionSessionKey),
      );
      if (existing) {
        const container = containerRef.current;
        if (container) {
          const cx = container.clientWidth / 2;
          const cy = container.clientHeight / 2;
          const scale = transformRef.current.scale;
          setTransform({
            x: cx - (existing.position.x + existing.size.width / 2) * scale,
            y: cy - (existing.position.y + existing.size.height / 2) * scale,
            scale,
          });
        }
        return;
      }

      // Look up pending spawn data — try both direct key and agent- prefixed
      let spawn = pendingMinionsRef.current.get(minionSessionKey);
      if (!spawn) {
        spawn = pendingMinionsRef.current.get(`agent-${minionSessionKey}`);
      }
      // Also try matching by taskId in case minionSessionKey is actually a taskId
      if (!spawn) {
        for (const s of pendingMinionsRef.current.values()) {
          if (s.taskId === minionSessionKey) { spawn = s; break; }
        }
      }

      // If no pending spawn data, reconstruct from leader's taskPlan.
      if (!spawn) {
        for (const node of nodesRef.current) {
          if (node.type !== "leader") continue;
          const ld = node.data as LeaderData;
          const task = (ld.taskPlan ?? []).find(
            (t) => t.minionSessionKey === minionSessionKey || t.taskId === minionSessionKey,
          );
          if (task) {
            spawn = {
              leaderNodeId: node.id,
              minionSessionKey: task.minionSessionKey,
              taskId: task.taskId,
              title: task.title,
              description: task.description,
              priority: task.priority,
            };
            break;
          }
        }
      }

      if (!spawn) {
        log.warn("reveal_missing", { minionSessionKey });
        return;
      }

      const leader = nodesRef.current.find((n) => n.id === spawn!.leaderNodeId);
      if (!leader) return;

      const minionTypeDef = getAllNodeTypes().find((t) => t.type === "minion");
      if (!minionTypeDef) return;

      const existingMinions = nodesRef.current.filter(
        (n) => n.type === "minion" && (n.data as MinionData).leaderId === leader.id,
      );
      const minionCount = existingMinions.length;
      const GAP_X = 60;
      const GAP_Y = 16;
      const MINIONS_PER_COLUMN = 4;
      const minionWidth = minionTypeDef.defaultSize.width;
      const minionHeight = minionTypeDef.defaultSize.height;
      const col = Math.floor(minionCount / MINIONS_PER_COLUMN);
      const row = minionCount % MINIONS_PER_COLUMN;

      // The dashboard is embedded in the leader now, so minions start to the
      // right of the leader itself.
      const anchorRight = leader.position.x + leader.size.width;

      const minionId = generateId();
      const minionX = snapToGrid(anchorRight + GAP_X + col * (minionWidth + GAP_X));
      const minionY = snapToGrid(leader.position.y + row * (minionHeight + GAP_Y));

      const taskState: MinionTaskState = {
        taskId: spawn.taskId,
        title: spawn.title,
        description: spawn.description,
        priority: spawn.priority,
        status: "in_progress",
        activeStep: null,
        progress: [],
        result: null,
      };

      const minionData: MinionData = {
        sessionKey: spawn.minionSessionKey,
        status: "running",
        leaderId: leader.id,
        taskQueue: [taskState],
        activeTaskIndex: 0,
        messages: [
          {
            id: `auto-${Date.now()}`,
            role: "user" as const,
            content: spawn.isAgent ? `Subagent: ${spawn.title}` : `Starting task: ${spawn.title}`,
            timestamp: Date.now(),
          },
        ],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
        model: spawn.model ?? projectSettingsRef.current?.defaultMinionModel ?? "claude-sonnet-5",
        harness: spawn.harness ?? projectSettingsRef.current?.defaultMinionHarness ?? "claude",
        permissionMode: (spawn.permissionMode ?? projectSettingsRef.current?.defaultPermissionMode ?? "auto") as PermissionMode,
        thinkingConfig: {
          ...(projectSettingsRef.current?.defaultMinionThinkingConfig ?? MINION_THINKING_CONFIG),
        },
        ...(spawn.worktreeBranch ? { worktreeBranch: spawn.worktreeBranch } : {}),
        ...(spawn.isAgent
          ? { agentTaskId: spawn.taskId, parentSessionKey: spawn.parentSessionKey }
          : {}),
      };

      const newNode: CanvasNode = {
        id: minionId,
        type: "minion",
        position: { x: minionX, y: minionY },
        size: { ...minionTypeDef.defaultSize },
        data: minionData,
      };

      dispatch({ type: "ADD_NODE", node: newNode });
      revealedMinionsRef.current.add(minionSessionKey);

      const edge = createEdge(
        leader.id, "task-out", "leader",
        minionId, "task-in", "minion",
      );
      if (edge) graphDispatch({ type: "ADD_EDGE", edge: edge });

      const container = containerRef.current;
      if (container) {
        const cx = container.clientWidth / 2;
        const cy = container.clientHeight / 2;
        const scale = transformRef.current.scale;
        setTransform({
          x: cx - (minionX + minionWidth / 2) * scale,
          y: cy - (minionY + minionHeight / 2) * scale,
          scale,
        });
      }

    },
    [dispatch, graphDispatch, setTransform],
  );

  const openCommandPalette = useCallback(() => {
    setContextMenu(null);
    setDashboardDropMenu(null);
    setCommandPaletteOpen(true);
  }, []);

  function createLeaderAtCursor(): boolean {
    const pointer = lastCanvasPointerRef.current;
    if (!pointer || !pointer.overEmptyCanvas || Date.now() - pointer.at > 10_000) {
      return false;
    }
    return createNode("leader", {
      anchor: { kind: "world", x: pointer.worldX, y: pointer.worldY },
    }) != null;
  }

  // ── Edge interaction handlers ──
  const handleEdgeClick = useCallback(
    (edgeId: string) => {
      // Clicking an edge clears node selection so the user can immediately
      // act on the edge (Delete, focus source/target) without ambiguity.
      setSelectedIds(new Set());
      setSelectedEdgeId(edgeId);
    },
    [],
  );

  const handleEdgeHover = useCallback((edgeId: string | null) => {
    setHoveredEdgeId(edgeId);
  }, []);

  // If the selected edge disappears (e.g. one of its nodes was deleted),
  // drop the selection so the inspector doesn't render against stale state.
  useEffect(() => {
    if (selectedEdgeId && !graph.edges.some((e) => e.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
    if (hoveredEdgeId && !graph.edges.some((e) => e.id === hoveredEdgeId)) {
      setHoveredEdgeId(null);
    }
  }, [graph.edges, selectedEdgeId, hoveredEdgeId]);

  const selectedEdge = useMemo(
    () => graph.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [graph.edges, selectedEdgeId],
  );

  /** World-space midpoint of the selected edge, used to anchor the
   *  edge inspector overlay. Null when no edge is selected or one of
   *  the endpoints is missing. */
  // A leader→leader `context` edge exposes the context-forwarding mode control.
  const selectedEdgeIsLeaderContext = useMemo(() => {
    if (!selectedEdge || selectedEdge.protocol !== "context") return false;
    const src = nodes.find((n) => n.id === selectedEdge.sourceNodeId);
    const tgt = nodes.find((n) => n.id === selectedEdge.targetNodeId);
    return src?.type === "leader" && tgt?.type === "leader";
  }, [selectedEdge, nodes]);

  const selectedEdgeStaleness = useMemo(
    () => (selectedEdge ? findContextEdgeStaleness(selectedEdge, nodes) : null),
    [selectedEdge, nodes],
  );

  const selectedEdgeMidpoint = useMemo(() => {
    if (!selectedEdge) return null;
    const src = nodes.find((n) => n.id === selectedEdge.sourceNodeId);
    const tgt = nodes.find((n) => n.id === selectedEdge.targetNodeId);
    if (!src || !tgt) return null;
    const a = getPortWorldPos(src, selectedEdge.sourcePortId, "output");
    const b = getPortWorldPos(tgt, selectedEdge.targetPortId, "input");
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }, [selectedEdge, nodes]);

  const handleDeleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    graphDispatch({ type: "REMOVE_EDGE", id: selectedEdgeId });
    setSelectedEdgeId(null);
  }, [selectedEdgeId, graphDispatch]);

  const handleFocusEdgeEndpoint = useCallback(
    (which: "source" | "target") => {
      if (!selectedEdge) return;
      const id =
        which === "source" ? selectedEdge.sourceNodeId : selectedEdge.targetNodeId;
      setSelectedIds(new Set([id]));
      focusNodes(new Set([id]));
    },
    [selectedEdge, focusNodes],
  );

  const removeCanvasNode = useCallback((node: CanvasNode) => {
    if (node.type !== "leader" || !socketSend) return;
    const command = canvasDetachCommand(node.data as LeaderData, node.id);
    if (command) socketSend(command);
  }, [socketSend]);
  // Keyboard shortcuts: space (pan), delete, undo/redo
  useCanvasKeyboard({
    selectedIds,
    setSelectedIds,
    selectedEdgeId,
    onDeleteSelectedEdge: handleDeleteSelectedEdge,
    nodes,
    graph,
    dispatch,
    onRemoveNode: removeCanvasNode,
    graphDispatch,
    spaceRef,
    isInsideGroup,
    setPendingGroupDelete,
    focusNodes,
    focusNextActive,
    copyLeaderSetup,
    pasteLeaderSetup,
    createLeaderAtCursor,
    openCommandPalette,
    undo,
    redo,
  });

  // Wheel handler is attached as a native DOM listener with { passive: false }
  // so that preventDefault() actually blocks the browser's built-in pinch-zoom.
  // React's onWheel is passive in modern browsers and cannot prevent it.
  //
  // We use requestAnimationFrame to coalesce multiple wheel events into a
  // single React state update per frame. On high-refresh displays (120Hz+),
  // wheel events can fire much faster than React can re-render. Accumulating
  // deltas and flushing once per frame reduces renders by up to 50%.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Accumulated pan deltas between rAF frames
    let pendingPanDx = 0;
    let pendingPanDy = 0;

    // Accumulated zoom state between rAF frames.
    // We store the last mouse position + cumulative zoom factor.
    let pendingZoom: {
      mouseX: number;
      mouseY: number;
      cumulativeFactor: number;
    } | null = null;

    let rafId: number | null = null;

    const flushPending = () => {
      rafId = null;

      // Apply accumulated zoom
      if (pendingZoom) {
        const { mouseX, mouseY, cumulativeFactor } = pendingZoom;
        pendingZoom = null;
        setTransform((prev) => {
          const newScale = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, prev.scale * cumulativeFactor),
          );
          const scaleChange = newScale / prev.scale;
          return {
            x: mouseX - (mouseX - prev.x) * scaleChange,
            y: mouseY - (mouseY - prev.y) * scaleChange,
            scale: newScale,
          };
        });
      }

      // Apply accumulated pan
      if (pendingPanDx !== 0 || pendingPanDy !== 0) {
        const dx = pendingPanDx;
        const dy = pendingPanDy;
        pendingPanDx = 0;
        pendingPanDy = 0;
        setTransform((prev) => ({
          ...prev,
          x: prev.x - dx,
          y: prev.y - dy,
        }));
      }
    };

    const scheduleFlush = () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(flushPending);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      // ── Pinch-to-zoom detection (conclusive, browser-provided) ──
      const isPinch = e.ctrlKey || e.metaKey;

      // ── Device detection via heuristic engine ───────────────────
      // Pinch is conclusive and must not seed the heuristic used by the next
      // ordinary wheel gesture.
      const device = isPinch ? null : wheelDetector.classify(e);

      // ── Scroll-capture zones (chat areas, dashboards, etc.) ─────
      // Any element marked with `data-scroll-capture` (or an ancestor of
      // the wheel target so marked) opts out of canvas pan/zoom and lets
      // the browser scroll its content natively.
      //
      // Two cases:
      //   1. Mouse wheel: always route to native scroll. Mice can't pinch
      //      and don't mid-gesture-drift between regions, so there is no
      //      gesture-continuity concern.
      //   2. Trackpad pan: route to native scroll only when no canvas pan
      //      is currently in progress. If the user started panning the
      //      canvas over the background and drifted over a scroll-capture
      //      zone mid-gesture, keep panning the canvas (gesture continuity).
      //
      // Pinch (ctrlKey/metaKey + wheel) always zooms the canvas regardless
      // of where the cursor is.
      const target = e.target as HTMLElement | null;
      const overScrollCapture = !!target?.closest?.("[data-scroll-capture]");

      if (overScrollCapture && !isPinch) {
        if (device === "mouse") {
          return;
        }
        if (device === "trackpad" && !wheelDetector.isPanGestureActive) {
          return;
        }
      }

      e.preventDefault();

      // The user is driving the viewport — abandon any camera glide in flight.
      cancelCameraAnim();

      const shouldZoom = isPinch || device === "mouse";

      if (shouldZoom) {
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = wheelZoomFactor(e, isPinch);

        // Accumulate: multiply zoom factors and use latest mouse position
        if (pendingZoom) {
          pendingZoom.mouseX = mouseX;
          pendingZoom.mouseY = mouseY;
          pendingZoom.cumulativeFactor *= zoomFactor;
        } else {
          pendingZoom = { mouseX, mouseY, cumulativeFactor: zoomFactor };
        }
      } else {
        // Accumulate trackpad pan deltas. Mark the wheel detector as actively
        // panning so subsequent events in the same gesture continue to pan
        // the canvas even if the pointer drifts over a scroll-capture zone
        // mid-gesture (gesture continuity).
        pendingPanDx += e.deltaX;
        pendingPanDy += e.deltaY;
        wheelDetector.markPanGestureActive();
      }

      scheduleFlush();
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (rafId !== null) cancelAnimationFrame(rafId);
      wheelDetector.reset();
    };
  }, [setTransform, cancelCameraAnim]);

  // Disable Linux PRIMARY-selection middle-click paste and middle-click
  // autoscroll across the whole document. A container-scoped listener
  // missed clicks that originated outside the canvas (chat inputs, side
  // panels) but ended inside it — those still triggered a paste on the
  // origin input. See `use-suppress-middle-click-paste.ts`.
  useSuppressMiddleClickPaste();

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const t = transformRef.current;
    const rect = container.getBoundingClientRect();
    lastCanvasPointerRef.current = {
      worldX: (e.clientX - rect.left - t.x) / t.scale,
      worldY: (e.clientY - rect.top - t.y) / t.scale,
      overEmptyCanvas: e.target === e.currentTarget,
      at: Date.now(),
    };
  }, []);

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Close context menu on any mouse down
      setContextMenu(null);

      if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
        e.preventDefault();
        cancelCameraAnim();
        setIsPanning(true);
        panRef.current = { startX: e.clientX, startY: e.clientY };
        const startTransform = transformRef.current;
        let latestX = e.clientX;
        let latestY = e.clientY;
        let panRafId: number | null = null;

        const flushPan = () => {
          panRafId = null;
          const start = panRef.current;
          if (!start) return;
          setTransform({
            ...startTransform,
            x: startTransform.x + latestX - start.startX,
            y: startTransform.y + latestY - start.startY,
          });
        };

        const handleMouseMove = (ev: MouseEvent) => {
          if (!panRef.current) return;
          latestX = ev.clientX;
          latestY = ev.clientY;
          if (panRafId === null) panRafId = requestAnimationFrame(flushPan);
        };

        const handleMouseUp = () => {
          if (panRafId !== null) {
            cancelAnimationFrame(panRafId);
            flushPan();
          }
          panRef.current = null;
          setIsPanning(false);
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
          window.removeEventListener("blur", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        window.addEventListener("blur", handleMouseUp);
        return;
      }

      // Left-click on empty canvas → start marquee selection (or deselect on click)
      if (e.button === 0 && e.target === e.currentTarget) {
        const startScreenX = e.clientX;
        const startScreenY = e.clientY;
        let didDragMarquee = false;

        // Disable text selection during marquee
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";

        const handleMouseMove = (ev: MouseEvent) => {
          const mdx = Math.abs(ev.clientX - startScreenX);
          const mdy = Math.abs(ev.clientY - startScreenY);
          if (!didDragMarquee && mdx + mdy > 5) {
            didDragMarquee = true;
          }
          if (didDragMarquee) {
            setMarquee({
              startX: startScreenX,
              startY: startScreenY,
              currentX: ev.clientX,
              currentY: ev.clientY,
            });

            // Compute which nodes intersect the marquee (in world coords)
            const t = transformRef.current;
            const container = containerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();

            const toWorld = (sx: number, sy: number) => ({
              x: (sx - rect.left - t.x) / t.scale,
              y: (sy - rect.top - t.y) / t.scale,
            });

            const p1 = toWorld(startScreenX, startScreenY);
            const p2 = toWorld(ev.clientX, ev.clientY);
            const selMinX = Math.min(p1.x, p2.x);
            const selMinY = Math.min(p1.y, p2.y);
            const selMaxX = Math.max(p1.x, p2.x);
            const selMaxY = Math.max(p1.y, p2.y);

            const hitIds = new Set<string>();
            for (const n of nodesRef.current) {
              // Node intersects marquee if rects overlap
              if (
                n.position.x + n.size.width > selMinX &&
                n.position.x < selMaxX &&
                n.position.y + n.size.height > selMinY &&
                n.position.y < selMaxY
              ) {
                hitIds.add(n.id);
              }
            }
            setSelectedIds(hitIds);
          }
        };

        const handleMouseUp = () => {
          if (!didDragMarquee) {
            // Simple click on empty canvas → deselect all (nodes + edges)
            setSelectedIds(new Set());
            setSelectedEdgeId(null);
          }
          setMarquee(null);
          document.body.style.userSelect = prevUserSelect;
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
      }
    },
    [setTransform, cancelCameraAnim],
  );

  const handleSelectNode = useCallback(
    (id: string, additive: boolean) => {
      // Selecting any node clears the edge selection — node and edge
      // selections are mutually exclusive so the inspector and Delete-key
      // semantics stay unambiguous.
      setSelectedEdgeId(null);
      setSelectedIds((prev) => {
        if (additive) {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        }
        if (prev.has(id) && prev.size === 1) return prev;
        return new Set([id]);
      });
    },
    [],
  );


  /** Padding inside a context-group frame around contained nodes. */
  const GROUP_PAD = 16;
  /** Minimum frame size when empty. */
  const GROUP_MIN_W = 300;
  const GROUP_MIN_H = 200;


  // ── Nodes inside a dragging context-group need elevated z-index ──
  // When a context-group is being dragged, its z-index jumps to 50 but
  // contained children stay at z-index 1, causing the group to render ON
  // TOP of its children.  We use the **snapshot** taken at drag start
  // (dragGroupContainedIdsRef) rather than live spatial detection so that
  // children of OTHER groups that the dragging group passes over don't
  // get incorrectly elevated.  Only the actual children that were inside
  // the group when the drag began should ride along at z-index 51.
  const draggingGroupContainedIds = useMemo<Set<string>>(() => {
    if (!draggingNodeId) return new Set();
    // Union all snapshots from all dragging context-groups — this covers
    // both single context-group drags and multi-select drags that include
    // context-groups.
    const map = dragGroupContainedIdsRef.current;
    if (map.size === 0) return new Set();
    if (map.size === 1) {
      // Fast path: single group
      return map.values().next().value ?? new Set();
    }
    const merged = new Set<string>();
    for (const ids of map.values()) {
      for (const id of ids) merged.add(id);
    }
    return merged;
  }, [draggingNodeId, nodes]);

  // ── Context-group auto-fit on membership change ─────
  // Debounced: waits for drag to settle before snapping layout.
  // When a node is *added*, auto-layouts all members in a clean
  // vertical stack then snaps the frame. When a node is *removed*,
  // shrinks the frame to fit the remaining nodes.

  /** Gap between stacked nodes inside a group. */
  const GROUP_GAP = 12;
  /** Debounce delay — lets the drag finish before we snap. */
  const GROUP_LAYOUT_DELAY = 100;

  const groupMembershipRef = useRef<Map<string, Set<string>>>(new Map());
  /** Tracks a size fingerprint per group so we refit when contained nodes resize (e.g. collapse). */
  const groupSizeFingerprintRef = useRef<Map<string, string>>(new Map());
  /** Tracks a layout fingerprint (positions+sizes) so we restack when a contained node is moved. */
  const groupLayoutFingerprintRef = useRef<Map<string, string>>(new Map());
  const groupLayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear any pending layout — a new nodes snapshot supersedes it
    if (groupLayoutTimerRef.current != null) {
      clearTimeout(groupLayoutTimerRef.current);
      groupLayoutTimerRef.current = null;
    }

    // ── Freeze membership tracking while any context-group is being dragged ──
    // When group A is dragged over group B their children spatially overlap
    // in transient ways:  group B would "claim" group A's children, group A
    // would "claim" group B's children, and fingerprints would churn causing
    // debounced reflows to fire mid-drag.  The simplest correct behaviour is
    // to skip the entire membership/layout pass until the drag ends.
    // This also applies when a multi-selection includes context-groups.
    // Using the `draggingNodeId` *state* (not just the ref) ensures the
    // effect re-runs once the drag completes, picking up final positions.
    if (draggingNodeId && dragGroupContainedIdsRef.current.size > 0) {
      return;
    }

    const groups = nodes.filter((n) => n.type === "context-group");
    if (groups.length === 0) {
      if (groupMembershipRef.current.size > 0) {
        groupMembershipRef.current = new Map();
      }
      return;
    }

    const contextNodeTypes = new Set(["markdown", "note", "file-viewer"]);

    // Quick-check: has membership, sizing, or positioning changed for any group?
    let anyChanged = false;
    const snapshots: Array<{
      group: CanvasNode;
      currentIds: Set<string>;
      grew: boolean;
      sizeChanged: boolean;
      positionChanged: boolean;
    }> = [];

    for (const group of groups) {
      const currentIds = new Set<string>();
      for (const n of nodes) {
        if (n.id === group.id) continue;
        if (!contextNodeTypes.has(n.type)) continue;
        if (isInsideGroup(n, group)) currentIds.add(n.id);
      }

      const prevIds = groupMembershipRef.current.get(group.id);
      const membershipSame =
        prevIds != null &&
        prevIds.size === currentIds.size &&
        [...currentIds].every((id) => prevIds.has(id));

      // Build a size fingerprint from contained nodes so we detect collapse/expand
      const sortedIds = [...currentIds].sort();
      const sizeFingerprint = sortedIds
        .map((id) => {
          const n = nodes.find((nd) => nd.id === id);
          return n ? `${id}:${n.size.width}x${n.size.height}` : id;
        })
        .join("|");
      const prevSizeFp = groupSizeFingerprintRef.current.get(group.id);
      const sizeChanged = membershipSame && sizeFingerprint !== prevSizeFp;

      // Build a layout fingerprint (positions + sizes) to detect in-group moves
      const layoutFingerprint = sortedIds
        .map((id) => {
          const n = nodes.find((nd) => nd.id === id);
          return n
            ? `${id}:${n.position.x},${n.position.y},${n.size.width}x${n.size.height}`
            : id;
        })
        .join("|");
      const prevLayoutFp = groupLayoutFingerprintRef.current.get(group.id);
      const positionChanged = membershipSame && !sizeChanged && layoutFingerprint !== prevLayoutFp;

      if (!membershipSame || sizeChanged || positionChanged) {
        anyChanged = true;
        snapshots.push({
          group,
          currentIds,
          grew: prevIds == null || currentIds.size > prevIds.size,
          sizeChanged,
          positionChanged,
        });
      }
    }

    if (!anyChanged) return;

    // ── Helper: re-stack contained nodes vertically and fit the group frame ──
    const reflowGroup = (
      group: CanvasNode,
      currentIds: Set<string>,
      mode: "restack" | "shrink",
    ) => {
      // Commit membership + fingerprints
      groupMembershipRef.current.set(group.id, currentIds);
      const sortedIds = [...currentIds].sort();
      const sizeFp = sortedIds
        .map((id) => {
          const n = nodesRef.current.find((nd) => nd.id === id);
          return n ? `${id}:${n.size.width}x${n.size.height}` : id;
        })
        .join("|");
      groupSizeFingerprintRef.current.set(group.id, sizeFp);

      // ── Empty: shrink to minimum ──
      if (currentIds.size === 0) {
        if (group.size.width !== GROUP_MIN_W || group.size.height !== GROUP_MIN_H) {
          dispatch({
            type: "RESIZE_NODE",
            id: group.id,
            size: { width: GROUP_MIN_W, height: GROUP_MIN_H },
          });
        }
        return;
      }

      const contained = nodesRef.current.filter((n) => currentIds.has(n.id));
      if (contained.length === 0) return;

      if (mode === "restack") {
        // Re-stack all nodes vertically then fit the frame
        const maxMemberW = Math.max(...contained.map((n) => n.size.width));
        const contentX = group.position.x + GROUP_PAD;
        let cursorY = group.position.y + GROUP_HEADER + GROUP_PAD;

        const sorted = [...contained].sort((a, b) => a.position.y - b.position.y);
        const moves: Array<{ id: string; position: Position }> = [];
        for (const n of sorted) {
          moves.push({ id: n.id, position: { x: contentX, y: cursorY } });
          cursorY += n.size.height + GROUP_GAP;
        }

        if (moves.length > 0) {
          dispatch({ type: "MOVE_GROUP", moves });
        }

        const totalH = cursorY - GROUP_GAP - (group.position.y + GROUP_HEADER + GROUP_PAD);
        const frameW = Math.max(GROUP_MIN_W, maxMemberW + GROUP_PAD * 2);
        const frameH = Math.max(GROUP_MIN_H, totalH + GROUP_HEADER + GROUP_PAD * 2);

        dispatch({
          type: "RESIZE_NODE",
          id: group.id,
          size: { width: frameW, height: frameH },
        });

        // Commit layout fingerprint using the *post-move* positions so the
        // next render won't re-detect a change and cause an infinite loop.
        const postLayoutFp = sortedIds
          .map((id) => {
            const move = moves.find((m) => m.id === id);
            const n = contained.find((nd) => nd.id === id);
            if (!move || !n) return id;
            return `${id}:${move.position.x},${move.position.y},${n.size.width}x${n.size.height}`;
          })
          .join("|");
        groupLayoutFingerprintRef.current.set(group.id, postLayoutFp);
      } else {
        // Shrink frame to fit remaining nodes' bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of contained) {
          minX = Math.min(minX, n.position.x);
          minY = Math.min(minY, n.position.y);
          maxX = Math.max(maxX, n.position.x + n.size.width);
          maxY = Math.max(maxY, n.position.y + n.size.height);
        }

        const newX = minX - GROUP_PAD;
        const newY = minY - GROUP_HEADER - GROUP_PAD;
        const newW = Math.max(GROUP_MIN_W, maxX - minX + GROUP_PAD * 2);
        const newH = Math.max(GROUP_MIN_H, maxY - minY + GROUP_PAD + GROUP_HEADER + GROUP_PAD);

        if (newX !== group.position.x || newY !== group.position.y) {
          dispatch({ type: "MOVE_NODE", id: group.id, position: { x: newX, y: newY } });
        }
        if (newW !== group.size.width || newH !== group.size.height) {
          dispatch({ type: "RESIZE_NODE", id: group.id, size: { width: newW, height: newH } });
        }

        // Commit layout fingerprint from current (unchanged) positions
        const layoutFp = sortedIds
          .map((id) => {
            const n = contained.find((nd) => nd.id === id);
            return n
              ? `${id}:${n.position.x},${n.position.y},${n.size.width}x${n.size.height}`
              : id;
          })
          .join("|");
        groupLayoutFingerprintRef.current.set(group.id, layoutFp);
      }
    };

    // ── Split snapshots by urgency ──
    // Size-only changes (collapse/expand) → immediate (no drag in progress)
    // Membership or position changes → debounced (drag may still be in progress)
    const immediateSnapshots = snapshots.filter((s) => s.sizeChanged);
    const debouncedSnapshots = snapshots.filter((s) => !s.sizeChanged);

    // Size-only changes (collapse / expand) — reflow now, no debounce
    for (const { group, currentIds } of immediateSnapshots) {
      reflowGroup(group, currentIds, "restack");
    }

    // Membership or position changes — debounce to let drag settle
    if (debouncedSnapshots.length > 0) {
      groupLayoutTimerRef.current = setTimeout(() => {
        groupLayoutTimerRef.current = null;

        // Double-check: if a context-group drag started between when we
        // queued this timeout and when it fires, bail out — the effect
        // will re-run with correct data once the drag ends.
        if (draggingNodeIdRef.current) {
          const dn = nodesRef.current.find((n) => n.id === draggingNodeIdRef.current);
          if (dn?.type === "context-group") return;
        }

        for (const { group, currentIds, grew, positionChanged } of debouncedSnapshots) {
          const liveGroup = nodesRef.current.find((n) => n.id === group.id);
          if (!liveGroup) continue;
          // Position changes and membership growth both need a full restack;
          // membership shrink just needs a bounding-box fit.
          const mode = grew || positionChanged ? "restack" : "shrink";
          reflowGroup(liveGroup, currentIds, mode);
        }
      }, GROUP_LAYOUT_DELAY);
    }

    return () => {
      if (groupLayoutTimerRef.current != null) {
        clearTimeout(groupLayoutTimerRef.current);
        groupLayoutTimerRef.current = null;
      }
    };
  }, [nodes, isInsideGroup, dispatch, draggingNodeId]);

  const handleMoveNode = useCallback(
    (id: string, position: Position) => {
      const currentNode = nodesRef.current.find((n) => n.id === id);
      if (!currentNode) return;

      const dx = position.x - currentNode.position.x;
      const dy = position.y - currentNode.position.y;

      // ── Multi-select drag ──
      // When the dragged node is part of a multi-selection, move ALL selected
      // nodes by the same delta. We also pull in any implicit companions
      // (leader→minions, context-group→contained children) so the group
      // stays coherent.
      const sel = selectedIdsRef.current;
      if (sel.has(id) && sel.size > 1) {
        const moveIds = new Set(sel);

        // Expand the move set with implicit companions for each selected node
        for (const selId of sel) {
          const selNode = nodesRef.current.find((n) => n.id === selId);
          if (!selNode) continue;

          if (selNode.type === "leader") {
            // Leader → drag attached minions
            for (const n of nodesRef.current) {
              if (n.type === "minion" && (n.data as MinionData).leaderId === selId) {
                moveIds.add(n.id);
              }
            }
          } else if (selNode.type === "context-group") {
            // Context group → drag contained children (use snapshot if available)
            const groupSnapshot = dragGroupContainedIdsRef.current.get(selId);
            if (groupSnapshot && groupSnapshot.size > 0) {
              for (const cid of groupSnapshot) moveIds.add(cid);
            } else {
              for (const n of nodesRef.current) {
                if (n.id === selId || n.type === "context-group") continue;
                if (isInsideGroup(n, selNode)) moveIds.add(n.id);
              }
            }
          }
        }

        const moves = [...moveIds].map((mid) => {
          const n = nodesRef.current.find((nd) => nd.id === mid)!;
          return {
            id: mid,
            position: mid === id ? position : { x: n.position.x + dx, y: n.position.y + dy },
          };
        }).filter((m) => m != null);

        dispatch({ type: "MOVE_GROUP", moves });
      } else if (currentNode.type === "leader") {
        // Leader drags its minions
        const attached = nodesRef.current.filter(
          (n) =>
            n.type === "minion" &&
            (n.data as MinionData).leaderId === currentNode.id,
        );
        const moves = [
          { id, position },
          ...attached.map((m) => ({
            id: m.id,
            position: { x: m.position.x + dx, y: m.position.y + dy },
          })),
        ];
        dispatch({ type: "MOVE_GROUP", moves });
      } else if (currentNode.type === "context-group") {
        // Context group drags nodes that were inside it when the drag started.
        // Using the snapshot (dragGroupContainedIdsRef) prevents the group from
        // accidentally "latching" onto unrelated nodes it passes over mid-drag.
        const snapshotIds = dragGroupContainedIdsRef.current.get(id);
        const contained = snapshotIds && snapshotIds.size > 0
          ? nodesRef.current.filter((n) => snapshotIds.has(n.id))
          : nodesRef.current.filter(
              (n) => n.id !== id && n.type !== "context-group" && isInsideGroup(n, currentNode),
            );
        const moves = [
          { id, position },
          ...contained.map((n) => ({
            id: n.id,
            position: { x: n.position.x + dx, y: n.position.y + dy },
          })),
        ];
        dispatch({ type: "MOVE_GROUP", moves });
      } else {
        dispatch({ type: "MOVE_NODE", id, position });
      }

      // ── Drop target detection during drag ──
      // Uses rectangle overlap: the dragged node activates a context-group
      // when at least 20% of its area overlaps the group's frame, OR when
      // the top-center of the dragged node enters the group.  This feels
      // natural — you don't need to shove the entire node inside.
      //
      // Skip detection when the node is being moved as part of a dragging
      // context-group — its children shouldn't trigger drop zones on other
      // groups they happen to pass over.
      // Check if this node is contained in ANY dragging context-group's snapshot
      let isPartOfDraggingGroup = false;
      for (const ids of dragGroupContainedIdsRef.current.values()) {
        if (ids.has(id)) { isPartOfDraggingGroup = true; break; }
      }
      if (draggingNodeIdRef.current === id && DROPPABLE_TYPES.has(currentNode.type) && !isPartOfDraggingGroup) {
        const nodeL = position.x;
        const nodeT = position.y;
        const nodeR = position.x + currentNode.size.width;
        const nodeB = position.y + currentNode.size.height;
        const nodeArea = currentNode.size.width * currentNode.size.height;

        let foundGroupId: string | null = null;
        let bestOverlap = 0;

        for (const n of nodesRef.current) {
          if (n.type !== "context-group") continue;
          const groupL = n.position.x;
          const groupT = n.position.y;
          const groupR = n.position.x + n.size.width;
          const groupB = n.position.y + n.size.height;

          // Compute overlap rectangle
          const overlapW = Math.max(0, Math.min(nodeR, groupR) - Math.max(nodeL, groupL));
          const overlapH = Math.max(0, Math.min(nodeB, groupB) - Math.max(nodeT, groupT));
          const overlapArea = overlapW * overlapH;
          const overlapRatio = nodeArea > 0 ? overlapArea / nodeArea : 0;

          // Also check if the top-center of the node is inside the group
          // (handles the case where you drag a node down into a group from above)
          const topCenterX = position.x + currentNode.size.width / 2;
          const topCenterY = position.y;
          const topCenterInside =
            topCenterX >= groupL && topCenterX <= groupR &&
            topCenterY >= groupT && topCenterY <= groupB;

          if ((overlapRatio > 0.2 || topCenterInside) && overlapArea > bestOverlap) {
            bestOverlap = overlapArea;
            foundGroupId = n.id;
          }
        }

        if (foundGroupId !== dropTargetGroupIdRef.current) {
          setDropTargetGroupId(foundGroupId);
        }
      }
    },
    [dispatch, isInsideGroup, DROPPABLE_TYPES],
  );

  const handleUpdateNodeData = useCallback(
    (id: string, data: unknown) => {
      dispatch({ type: "UPDATE_NODE_DATA", id, data });
    },
    [dispatch],
  );

  const handleResizeNode = useCallback(
    (id: string, size: Size) => {
      dispatch({ type: "RESIZE_NODE", id, size });
    },
    [dispatch],
  );

  // ── Connection drag handlers ────────────────────────────

  const createConnectedLeaderFromDrop = useCallback(
    (
      sourcePort: PortInfo,
      compatiblePortId: string,
      worldX: number,
      worldY: number,
      prompt: string | null,
      count = 1,
      contextMode?: ContextEdgeMode,
      resolvedPosition?: Position,
    ) => {
      const safeCount = Math.max(1, Math.min(3, Math.floor(count)));
      if (safeCount > 1) {
        const leaderDef = getAllNodeTypes().find((td) => td.type === "leader");
        const stepX = (leaderDef?.defaultSize.width ?? 560) + 48;
        const createdIds: string[] = [];
        for (let i = 0; i < safeCount; i += 1) {
          const before = new Set(selectedIdsRef.current);
          createConnectedLeaderFromDrop(
            sourcePort,
            compatiblePortId,
            worldX + i * stepX,
            worldY,
            prompt,
            1,
            contextMode,
          );
          for (const id of selectedIdsRef.current) {
            if (!before.has(id)) createdIds.push(id);
          }
        }
        if (createdIds.length > 0) setSelectedIds(new Set(createdIds));
        return;
      }
      const placement = computeLeaderDropPlacement(
        worldX,
        worldY,
        nodesRef.current,
      );
      if (!placement) return;
      const { leaderDef } = placement;
      const position = resolvedPosition ?? placement.position;

      const baseData = createDefaultNodeData(
        "leader",
        projectSettingsRef.current,
      ) as LeaderData;
      const leaderData: LeaderData = prompt
        ? { ...baseData, autoStartPrompt: prompt.trim() }
        : baseData;

      const newNode: CanvasNode = {
        id: generateId(),
        type: "leader",
        position,
        size: { ...leaderDef.defaultSize },
        data: leaderData,
      };
      dispatch({ type: "ADD_NODE", node: newNode });
      setSelectedIds(new Set([newNode.id]));
      recenterCameraOnPlacement(null, position, newNode.size);

      // Empty drop-created leaders focus their prompt input; ones seeded with a
      // prompt auto-start and don't need the textarea focused.
      if (!prompt) {
        requestLeaderInputFocus(newNode.id);
      }

      const newEdge = createEdge(
        sourcePort.nodeId,
        sourcePort.portId,
        sourcePort.nodeType,
        newNode.id,
        compatiblePortId,
        "leader",
        leaderData,
      );
      if (newEdge) {
        const edge =
          contextMode && contextMode !== "dashboard"
            ? { ...newEdge, contextMode }
            : newEdge;
        graphDispatch({ type: "ADD_EDGE", edge });
      }
    },
    [dispatch, graphDispatch, recenterCameraOnPlacement],
  );

  const handleConnectionStart = useCallback(
    (port: PortInfo, e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Read current values from refs so this callback stays stable
      const currentTransform = transformRef.current;
      const currentNodes = nodesRef.current;

      setDashboardDropMenu(null);

      const rect = container.getBoundingClientRect();
      const worldX = (e.clientX - rect.left - currentTransform.x) / currentTransform.scale;
      const worldY = (e.clientY - rect.top - currentTransform.y) / currentTransform.scale;

      // Compute valid targets: all visible ports on all nodes that can connect
      const targets = new Set<string>();
      for (const node of currentNodes) {
        const contract = getContract(node.type);
        if (!contract) continue;
        if (node.id === port.nodeId) continue; // can't connect to self

        for (const p of contract.ports) {
          // If source is output, target must be input (and vice versa)
          let valid = false;
          if (port.direction === "output" && p.direction === "input") {
            valid = canConnect(port.nodeType, port.portId, node.type, p.id);
            if (valid) {
              valid = isPortOpen(node.type, p.id, node.data);
            }
          } else if (port.direction === "input" && p.direction === "output") {
            valid = canConnect(node.type, p.id, port.nodeType, port.portId);
            if (valid) {
              valid = isPortOpen(port.nodeType, port.portId,
                currentNodes.find((n) => n.id === port.nodeId)?.data);
            }
          }
          if (valid) {
            targets.add(`${node.id}:${p.id}`);
          }
        }
      }

      setValidTargets(targets);
      snapTargetRef.current = null;
      connectionHandledByPortRef.current = false;
      setConnectionDrag({ source: port, mouseX: worldX, mouseY: worldY, snapTarget: null });

      // Disable text selection during drag
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const handleMouseMove = (ev: MouseEvent) => {
        // Read latest transform from ref — it may change during drag
        const t = transformRef.current;
        const r = container.getBoundingClientRect();
        const wx = (ev.clientX - r.left - t.x) / t.scale;
        const wy = (ev.clientY - r.top - t.y) / t.scale;

        // ── Snap detection: find nearest valid target port ──────────
        // Use latest nodes from ref for accurate positions during drag
        const liveNodes = nodesRef.current;
        let nearestTarget: PortInfo | null = null;
        let nearestDist = SNAP_RADIUS;

        for (const node of liveNodes) {
          const contract = getContract(node.type);
          if (!contract) continue;
          const targetDir = port.direction === "output" ? "input" : "output";
          for (const p of contract.ports) {
            if (!targets.has(`${node.id}:${p.id}`)) continue;
            const pos = getPortWorldPos(node, p.id, targetDir);
            if (!pos) continue;
            const dist = Math.hypot(wx - pos.x, wy - pos.y);
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestTarget = {
                nodeId: node.id,
                portId: p.id,
                nodeType: node.type,
                direction: targetDir,
                protocol: p.protocol,
              };
            }
          }
        }

        snapTargetRef.current = nearestTarget;
        setConnectionDrag((prev) =>
          prev ? { ...prev, mouseX: wx, mouseY: wy, snapTarget: nearestTarget } : null,
        );
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        // The port-level mouseup (PortDot) fires before this window-level
        // mouseup, so the source of truth for "did this drop already get
        // consumed by landing on a port?" is connectionHandledByPortRef —
        // not snapTargetRef, which can be null when the user releases
        // directly on a port without ever entering snap range.
        const compatiblePort =
          port.direction === "output"
            ? LEADER_CONTRACT.ports.find(
                (p) => p.direction === "input" && p.protocol === port.protocol,
              )
            : undefined;
        const action = decideConnectionDropAction({
          source: port,
          snapTarget: snapTargetRef.current,
          consumedByPort: connectionHandledByPortRef.current,
          compatibleLeaderInputPortId: compatiblePort?.id ?? null,
        });

        if (action.kind === "snap-connect") {
          const snap = action.snap;
          let srcNodeId: string, srcPortId: string, srcNodeType: string;
          let tgtNodeId: string, tgtPortId: string, tgtNodeType: string;
          if (port.direction === "output") {
            srcNodeId = port.nodeId; srcPortId = port.portId; srcNodeType = port.nodeType;
            tgtNodeId = snap.nodeId; tgtPortId = snap.portId; tgtNodeType = snap.nodeType;
          } else {
            srcNodeId = snap.nodeId; srcPortId = snap.portId; srcNodeType = snap.nodeType;
            tgtNodeId = port.nodeId; tgtPortId = port.portId; tgtNodeType = port.nodeType;
          }
          const tgtNode = nodesRef.current.find((n) => n.id === tgtNodeId);
          const edge = createEdge(srcNodeId, srcPortId, srcNodeType, tgtNodeId, tgtPortId, tgtNodeType, tgtNode?.data);
          if (edge) {
            graphDispatch({ type: "ADD_EDGE", edge });
          }
        } else if (
          (action.kind === "show-dashboard-menu" ||
            action.kind === "create-default-leader") &&
          compatiblePort
        ) {
          const cont = containerRef.current;
          if (cont) {
            const t = transformRef.current;
            const rect = cont.getBoundingClientRect();
            const dropX = (upEvent.clientX - rect.left - t.x) / t.scale;
            const dropY = (upEvent.clientY - rect.top - t.y) / t.scale;

            if (action.kind === "show-dashboard-menu") {
              const placement = computeLeaderDropPlacement(
                dropX,
                dropY,
                nodesRef.current,
              );
              if (placement) {
                setDashboardDropMenu({
                  screenX: upEvent.clientX,
                  screenY: upEvent.clientY,
                  worldX: dropX,
                  worldY: dropY,
                  source: { ...port },
                  compatiblePortId: compatiblePort.id,
                  placement,
                });
                // Follow the collision-resolved placement, not the raw drop
                // point. The same resolved position is retained by the menu
                // and used when the leader is actually created.
                recenterCameraOnPlacement(null, placement.position, placement.size);
              }
            } else {
              createConnectedLeaderFromDrop(
                port,
                compatiblePort.id,
                dropX,
                dropY,
                null,
              );
            }
          }
        }

        connectionHandledByPortRef.current = false;
        snapTargetRef.current = null;
        setConnectionDrag(null);
        setValidTargets(EMPTY_VALID_TARGETS);
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [createConnectedLeaderFromDrop, graphDispatch, recenterCameraOnPlacement],
  );

  const handleConnectionEnd = useCallback(
    (targetPort: PortInfo) => {
      const drag = connectionDragRef.current;
      if (!drag) return;
      // Tell the window-level mouseup that the port consumed this drop, so
      // it won't fall through to the "drop on empty canvas" branch (which
      // would offer to create a new leader / show the dashboard-drop menu
      // even though we just connected to an existing port).
      connectionHandledByPortRef.current = true;
      const { source } = drag;

      // Determine which is source (output) and which is target (input)
      let srcNodeId: string, srcPortId: string, srcNodeType: string;
      let tgtNodeId: string, tgtPortId: string, tgtNodeType: string;

      if (source.direction === "output") {
        srcNodeId = source.nodeId;
        srcPortId = source.portId;
        srcNodeType = source.nodeType;
        tgtNodeId = targetPort.nodeId;
        tgtPortId = targetPort.portId;
        tgtNodeType = targetPort.nodeType;
      } else {
        // Dragged from input — target port should be the output
        srcNodeId = targetPort.nodeId;
        srcPortId = targetPort.portId;
        srcNodeType = targetPort.nodeType;
        tgtNodeId = source.nodeId;
        tgtPortId = source.portId;
        tgtNodeType = source.nodeType;
      }

      const tgtNode = nodesRef.current.find((n) => n.id === tgtNodeId);
      const edge = createEdge(
        srcNodeId, srcPortId, srcNodeType,
        tgtNodeId, tgtPortId, tgtNodeType,
        tgtNode?.data,
      );

      if (edge) {
        graphDispatch({ type: "ADD_EDGE", edge });
      }

      // Clean up drag state (mouseup handler will also fire)
      setConnectionDrag(null);
      setValidTargets(EMPTY_VALID_TARGETS);
    },
    [graphDispatch],
  );

  const getViewportCenterPoint = useCallback((): Position => {
    const t = transformRef.current;
    const container = containerRef.current;
    return {
      x: container ? (container.clientWidth / 2 - t.x) / t.scale : 400,
      y: container ? (container.clientHeight / 2 - t.y) / t.scale : 300,
    };
  }, []);

  const resolveNodePosition = useCallback(
    (
      typeDef: { defaultSize: Size },
      anchor: CreateNodeAnchor,
    ): Position => {
      let rawX: number;
      let rawY: number;

      if (anchor.kind === "world") {
        rawX = anchor.x - typeDef.defaultSize.width / 2;
        rawY = anchor.y - typeDef.defaultSize.height / 2;
      } else if (anchor.kind === "above-top") {
        // Default placement: stack the new card above the top-most card so
        // fresh leaders land at the top of the canvas. Falls back to the
        // viewport centre when the canvas is empty.
        const center = getViewportCenterPoint();
        const pos = placeAboveTopNode(
          nodesRef.current,
          typeDef.defaultSize,
          ABOVE_TOP_GAP,
          {
            x: center.x - typeDef.defaultSize.width / 2,
            y: center.y - typeDef.defaultSize.height / 2,
          },
        );
        rawX = pos.x;
        rawY = pos.y;
      } else {
        const pointer = lastCanvasPointerRef.current;
        const pointerIsRecent =
          anchor.preferCursor &&
          pointer != null &&
          Date.now() - pointer.at < 10_000;

        if (pointerIsRecent) {
          rawX = pointer.worldX - typeDef.defaultSize.width / 2;
          rawY = pointer.worldY - typeDef.defaultSize.height / 2;
        } else {
          const selectedNode = [...selectedIdsRef.current]
            .map((id) => nodesRef.current.find((n) => n.id === id))
            .find((n): n is CanvasNode => n != null);
          const recentLeader = recentActiveLeaderIdRef.current
            ? nodesRef.current.find((n) => n.id === recentActiveLeaderIdRef.current)
            : null;
          const anchorNode = selectedNode ?? recentLeader;

          if (anchorNode) {
            rawX = anchorNode.position.x + anchorNode.size.width + 48;
            rawY = anchorNode.position.y;
          } else {
            const center = getViewportCenterPoint();
            rawX = center.x - typeDef.defaultSize.width / 2;
            rawY = center.y - typeDef.defaultSize.height / 2;
          }
        }
      }

      return findNonOverlappingPosition(
        rawX,
        rawY,
        typeDef.defaultSize.width,
        typeDef.defaultSize.height,
        nodesRef.current,
      );
    },
    [getViewportCenterPoint],
  );

  const createNode = useCallback(
    (
      type: string,
      {
        anchor,
        prompt = null,
        focus = false,
        leaderPreset = null,
      }: {
        anchor: CreateNodeAnchor;
        prompt?: string | null;
        focus?: boolean;
        leaderPreset?: LeaderPreset | null;
      },
    ): CanvasNode | null => {
      const typeDef = getAllNodeTypes().find((t) => t.type === type);
      if (!typeDef) return null;

      const baseData = createDefaultNodeData(type, projectSettingsRef.current);
      const presetData =
        type === "leader" && leaderPreset
          ? applyPresetToLeaderData(leaderPreset, baseData as LeaderData)
          : baseData;
      const trimmedPrompt = prompt?.trim() ?? "";
      // Seed the new node's data with any typed value (Ctrl+K palette): a
      // leader auto-starts with it, a markdown/note/etc. gets it as content.
      const data = trimmedPrompt
        ? applyPromptSeed(type, presetData, trimmedPrompt)
        : presetData;
      const position = resolveNodePosition(typeDef, anchor);

      const node: CanvasNode = {
        id: generateId(),
        type,
        position,
        size: { ...typeDef.defaultSize },
        data,
      };
      dispatch({ type: "ADD_NODE", node });
      setSelectedIds(new Set([node.id]));

      // Fresh, empty leader nodes should hand focus to the prompt input so the
      // user can type immediately. Auto-starting leaders (a prompt was supplied
      // at creation) skip this — the session takes over, not the textarea.
      if (type === "leader" && !trimmedPrompt) {
        requestLeaderInputFocus(node.id);
      }

      const container = containerRef.current;
      if (focus && container) {
        // Creation focus is authoritative. Without cancelling an older glide
        // (for example, one started by a preceding node drag), its next rAF
        // tick can overwrite this transform and pull the new node off-screen.
        cancelCameraAnim();
        const target = focusTransformOnRects(
          [{ ...position, ...typeDef.defaultSize }],
          { width: container.clientWidth, height: container.clientHeight },
          { padding: 80, maxScale: 1 },
        );
        if (target) setTransform(target);
      }

      return node;
    },
    [cancelCameraAnim, dispatch, resolveNodePosition, setTransform],
  );

  const addNode = useCallback(
    (type: string) => {
      // Leaders default to stacking above the top-most card; right-click
      // placement (world anchor) overrides this when the user picks a spot.
      const anchor: CreateNodeAnchor =
        type === "leader"
          ? { kind: "above-top" }
          : { kind: "smart", preferCursor: false };
      createNode(type, { anchor, focus: true });
    },
    [createNode],
  );

  const startFromEmptyCanvas = useCallback(
    (description: string) => {
      createNode("leader", {
        anchor: { kind: "smart", preferCursor: false },
        prompt: buildEmptyCanvasLeaderPrompt(description),
        focus: true,
      });
    },
    [createNode],
  );

  /** Add a node at a specific world position (used by context menu) */
  const addNodeAtPosition = useCallback(
    (type: string, worldX: number, worldY: number) => {
      createNode(type, { anchor: { kind: "world", x: worldX, y: worldY } });
    },
    [createNode],
  );

  const handleCommandPaletteCreate = useCallback(
    (item: PaletteItem, prompt: string) => {
      if (item.kind === "node") {
        // Any typed text seeds the new node (createNode → applyPromptSeed):
        // a leader auto-starts with it, a markdown/note gets it as content.
        createNode(item.type, {
          anchor: { kind: "smart", preferCursor: true },
          prompt,
        });
      } else {
        const preset = projectSettingsRef.current?.leaderPresets?.find(
          (p) => p.id === item.id,
        );
        if (preset) {
          createNode("leader", {
            anchor: { kind: "smart", preferCursor: true },
            prompt,
            leaderPreset: preset,
          });
        }
      }
      setCommandPaletteOpen(false);
    },
    [createNode],
  );

  /** Handle right-click on empty canvas area */
  const handleCanvasContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Only show when right-clicking directly on the canvas background
      if (e.target !== e.currentTarget) return;
      e.preventDefault();

      const t = transformRef.current;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();

      const worldX = (e.clientX - rect.left - t.x) / t.scale;
      const worldY = (e.clientY - rect.top - t.y) / t.scale;

      setContextMenu({
        screenX: e.clientX,
        screenY: e.clientY,
        worldX,
        worldY,
      });
    },
    [],
  );

  const handleContextMenuSelect = useCallback(
    (type: string) => {
      if (contextMenu) {
        addNodeAtPosition(type, contextMenu.worldX, contextMenu.worldY);
      }
      setContextMenu(null);
    },
    [contextMenu, addNodeAtPosition],
  );

  const handleContextMenuClose = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleDashboardDropMenuSelect = useCallback(
    (type: string) => {
      if (!dashboardDropMenu) return;
      // The menu offers the three context-forwarding modes. Spawn a connected
      // leader and stamp the chosen mode onto the new context edge.
      const contextMode = resolveContextMode(type);
      createConnectedLeaderFromDrop(
        dashboardDropMenu.source,
        dashboardDropMenu.compatiblePortId,
        dashboardDropMenu.worldX,
        dashboardDropMenu.worldY,
        null,
        1,
        contextMode,
        dashboardDropMenu.placement.position,
      );
      setDashboardDropMenu(null);
    },
    [createConnectedLeaderFromDrop, dashboardDropMenu],
  );

  const handleDashboardDropMenuClose = useCallback(() => {
    setDashboardDropMenu(null);
  }, []);

  /** Create a new markdown node from a chat response's text content */
  const addContentNode = useCallback(
    (content: string) => {
      const allTypes = getAllNodeTypes();
      const typeDef = allTypes.find((t) => t.type === "markdown");
      if (!typeDef) return;

      const t = transformRef.current;
      const container = containerRef.current;
      const centerX = container
        ? (container.clientWidth / 2 - t.x) / t.scale
        : 400;
      const centerY = container
        ? (container.clientHeight / 2 - t.y) / t.scale
        : 300;

      const rawX = centerX - typeDef.defaultSize.width / 2;
      const rawY = centerY - typeDef.defaultSize.height / 2;
      const position = findNonOverlappingPosition(
        rawX,
        rawY,
        typeDef.defaultSize.width,
        typeDef.defaultSize.height,
        nodesRef.current,
      );

      // Derive a short title from the first line of content
      const firstLine = content.split("\n")[0]?.slice(0, 60) || "Untitled";
      const title = firstLine.length >= 60 ? firstLine + "..." : firstLine;

      const node: CanvasNode = {
        id: generateId(),
        type: "markdown",
        position,
        size: { ...typeDef.defaultSize },
        data: { title, content, viewMode: "view" },
      };
      dispatch({ type: "ADD_NODE", node });
      setSelectedIds(new Set([node.id]));
    },
    [dispatch],
  );

  // ── File drop handling (extracted to custom hook) ──
  const {
    isDragOverCanvas,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleFileDrop,
  } = useCanvasFileDrop({
    dispatch,
    setSelectedIds,
    containerRef,
    transformRef,
    nodesRef,
    projectPath,
  });

  // ── Global paste → ImageNode / MarkdownNode ───────────
  //
  // When the clipboard carries an image and no text-editable element
  // is focused, drop a new ImageNode into the viewport. When it carries
  // plain text, drop a MarkdownNode with that text as its content.
  // Placement goes through findNonOverlappingPosition so the new node
  // lands near the viewport center without sitting on top of an
  // existing node.
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent): void => {
      // Skip when the user is pasting into an input / textarea / contenteditable.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const editable = target.isContentEditable === true;
        if (editable || tag === "INPUT" || tag === "TEXTAREA") return;
      }

      const clipboard = e.clipboardData;
      if (!clipboard) return;

      // 1. Image file on the clipboard → ImageNode.
      const imageItem = Array.from(clipboard.items).find(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      );
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        void createImageNodeFromFile(
          file,
          dispatch,
          setSelectedIds,
          transformRef.current,
          nodesRef.current,
          getViewportCenterPoint(),
        );
        return;
      }

      // 2. Plain text on the clipboard → MarkdownNode.
      const text = clipboard.getData("text/plain");
      const created = createMarkdownNodeFromText(
        text,
        dispatch,
        setSelectedIds,
        transformRef.current,
        nodesRef.current,
        getViewportCenterPoint(),
      );
      if (created) e.preventDefault();
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [dispatch, getViewportCenterPoint, setSelectedIds]);

  const zoomTo = useCallback(
    (newScale: number) => {
      const container = containerRef.current;
      if (!container) return;
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      setTransform((prev) => {
        const clamped = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, newScale),
        );
        const scaleChange = clamped / prev.scale;
        return {
          x: cx - (cx - prev.x) * scaleChange,
          y: cy - (cy - prev.y) * scaleChange,
          scale: clamped,
        };
      });
    },
    [setTransform],
  );

  const fitView = useCallback(() => {
    if (nodes.length === 0) {
      setTransform({ x: 0, y: 0, scale: 1 });
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + n.size.width);
      maxY = Math.max(maxY, n.position.y + n.size.height);
    }

    const padding = 60;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const scaleX = container.clientWidth / contentW;
    const scaleY = container.clientHeight / contentH;
    const scale = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(scaleX, scaleY)),
    );

    setTransform({
      x:
        container.clientWidth / 2 -
        ((minX + maxX) / 2) * scale,
      y:
        container.clientHeight / 2 -
        ((minY + maxY) / 2) * scale,
      scale,
    });
  }, [nodes, setTransform]);

  const handleTidyLayout = useCallback(() => {
    const container = containerRef.current;
    const center = viewportCenter(
      transform,
      container
        ? { width: container.clientWidth, height: container.clientHeight }
        : undefined,
    );
    const moves = computeAutoLayout(nodes, graph.edges, { center });
    if (moves.length > 0) {
      dispatch({ type: "MOVE_GROUP", moves });
    }
  }, [nodes, graph.edges, transform, dispatch]);

  const leaderSessionTopicKey = useMemo(() => {
    const topics = nodes
      .filter((n) => n.type === "leader")
      .map((n) => (n.data as LeaderData).sessionKey)
      .filter((key): key is string => typeof key === "string" && key.length > 0)
      .map((key) => sessionTopic(key))
      .sort();
    return Array.from(new Set(topics)).join("\n");
  }, [nodes]);

  // ── Handle server-side minion_spawned + agent_spawned events ──
  // Instead of auto-creating minion nodes, we store spawn data so the
  // user can reveal minions on demand from the leader's task plan UI.
  useEffect(() => {
    if (!socketSubscribe) return;
    const topics = leaderSessionTopicKey
      ? leaderSessionTopicKey.split("\n")
      : [];
    if (topics.length === 0) return;
    return subscribeSocketTopics(socketSubscribe, topics, (msg: unknown) => {
      const serverMsg = msg as { type: string; [key: string]: unknown };

      // ── task_plan_update — authoritative plan state from server ──
      // Fires on plan_task, assign_task, and complete_task. Merges server
      // task records into the leader's taskPlan, preserving any
      // frontend-only fields (cost, sessionSummary) accumulated at close.
      if (serverMsg.type === "task_plan_update") {
        const { leaderSessionKey, tasks } = serverMsg as unknown as {
          leaderSessionKey: string;
          tasks: Array<{
            taskId: string;
            title: string;
            description: string;
            priority: "low" | "medium" | "high" | "critical";
            executor: "leader" | "minion";
            minionSessionKey: string | null;
            status: TaskPlanItem["status"];
            createdAt: number;
            completedAt: number | null;
            result: string | null;
          }>;
        };

        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) return;

        const leaderData = leader.data as LeaderData;
        // Build a map of existing plan items to preserve frontend-only fields
        const existingMap = new Map(
          (leaderData.taskPlan ?? []).map((t) => [t.taskId, t]),
        );

        const newPlan: TaskPlanItem[] = tasks.map((serverTask) => {
          const existing = existingMap.get(serverTask.taskId);
          return {
            taskId: serverTask.taskId,
            title: serverTask.title,
            description: serverTask.description,
            priority: serverTask.priority,
            status: serverTask.status,
            executor: serverTask.executor,
            minionSessionKey: serverTask.minionSessionKey,
            result: serverTask.result,
            // Preserve frontend-accumulated fields
            cost: existing?.cost ?? 0,
            createdAt: serverTask.createdAt,
            completedAt: serverTask.completedAt,
            sessionSummary: existing?.sessionSummary ?? "",
            activeStep:
              serverTask.status === "running" || serverTask.status === "starting"
                ? (existing?.activeStep ?? null)
                : null,
            progress: existing?.progress ?? [],
          };
        });

        dispatch({
          type: "UPDATE_NODE_DATA",
          id: leader.id,
          data: { ...leaderData, taskPlan: newPlan },
        });
        return;
      }

      // ── minion_status on the leader topic — live progress/result detail ──
      // Minion report tools emit to both the minion session and the owning
      // leader session. The minion node consumes the former; this branch keeps
      // the leader task plan live even when the minion node is not revealed.
      if (serverMsg.type === "minion_status") {
        const {
          leaderSessionKey,
          minionSessionKey,
          taskId,
          trigger,
          message,
        } = serverMsg as unknown as {
          leaderSessionKey?: string;
          minionSessionKey: string;
          taskId?: string;
          trigger: "step" | "done" | "fail";
          message: string;
        };

        if (!leaderSessionKey && !taskId) return;
        const leader = nodesRef.current.find((n) => {
          if (n.type !== "leader") return false;
          const ld = n.data as LeaderData;
          return (
            ld.sessionKey === leaderSessionKey ||
            (ld.taskPlan ?? []).some(
              (t) =>
                t.taskId === taskId ||
                t.minionSessionKey === minionSessionKey,
            )
          );
        });
        if (!leader) return;

        const leaderData = leader.data as LeaderData;
        const taskPlan = (leaderData.taskPlan ?? []).map((task) => {
          if (
            task.taskId !== taskId &&
            task.minionSessionKey !== minionSessionKey
          ) {
            return task;
          }
          const progress =
            trigger === "step"
              ? [...(task.progress ?? []), message].slice(-20)
              : task.progress ?? [];
          return {
            ...task,
            status:
              trigger === "done"
                ? "completed"
                : trigger === "fail"
                  ? "failed"
                  : task.status === "planned" || task.status === "starting"
                    ? "running"
                    : task.status,
            result: trigger === "done" || trigger === "fail" ? message : task.result,
            completedAt:
              trigger === "done" || trigger === "fail"
                ? Date.now()
                : task.completedAt,
            activeStep: trigger === "step" ? message : null,
            progress,
            sessionSummary: message,
          } satisfies TaskPlanItem;
        });

        dispatch({
          type: "UPDATE_NODE_DATA",
          id: leader.id,
          data: { ...leaderData, taskPlan },
        });
        return;
      }

      // ── Legacy/settled minion completion notification ──
      if (serverMsg.type === "minion_completed") {
        const {
          leaderSessionKey,
          minionSessionKey,
          taskId,
          status,
          result,
        } = serverMsg as unknown as {
          leaderSessionKey: string;
          minionSessionKey: string;
          taskId: string;
          status: "completed" | "failed";
          result: string;
        };

        const leader = nodesRef.current.find(
          (n) =>
            n.type === "leader" &&
            (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) return;

        const leaderData = leader.data as LeaderData;
        const taskPlan = (leaderData.taskPlan ?? []).map((task) =>
          task.taskId === taskId || task.minionSessionKey === minionSessionKey
            ? {
                ...task,
                status,
                result,
                completedAt: Date.now(),
                activeStep: null,
                sessionSummary: result,
              }
            : task,
        );

        dispatch({
          type: "UPDATE_NODE_DATA",
          id: leader.id,
          data: { ...leaderData, taskPlan },
        });
        return;
      }

      // ── MCP assign_task → minion_spawned ──
      // Store spawn data for on-demand reveal instead of auto-creating nodes
      if (serverMsg.type === "minion_spawned") {
        const {
          leaderSessionKey,
          minionSessionKey,
          taskId,
          title,
          description,
          priority,
          worktreeBranch,
          model,
          harness,
          permissionMode,
        } = serverMsg as unknown as {
          leaderSessionKey: string;
          minionSessionKey: string;
          taskId: string;
          title: string;
          description: string;
          priority: "low" | "medium" | "high" | "critical";
          worktreeBranch?: string | null;
          model?: string | null;
          harness?: string | null;
          permissionMode?: PermissionMode;
        };

        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) {
          log.warn("spawn_leader_missing", {
            agentKind: "minion",
            leaderSessionKey,
          });
          return;
        }
        if (!claimSpawnEvent(spawnedMinionsRef.current, minionSessionKey, true)) return;

        // Store spawn data — node created on demand via revealMinion
        pendingMinionsRef.current.set(minionSessionKey, {
          leaderNodeId: leader.id,
          minionSessionKey,
          taskId,
          title,
          description,
          priority,
          worktreeBranch,
          model,
          harness,
          permissionMode,
        });

        return;
      }

      // ── SDK Agent tool → agent_spawned ──
      // Store spawn data for on-demand reveal
      if (serverMsg.type === "agent_spawned") {
        const {
          leaderSessionKey,
          taskId,
          title,
          description,
        } = serverMsg as unknown as {
          leaderSessionKey: string;
          taskId: string;
          title: string;
          description: string;
        };

        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) {
          log.warn("spawn_leader_missing", {
            agentKind: "subagent",
            leaderSessionKey,
          });
          return;
        }
        const dedupKey = agentSpawnDedupKey(taskId);
        if (!claimSpawnEvent(spawnedMinionsRef.current, dedupKey, true)) return;

        // Store spawn data — node created on demand via revealMinion
        pendingMinionsRef.current.set(dedupKey, {
          leaderNodeId: leader.id,
          minionSessionKey: null,
          taskId,
          title: title ?? description,
          description: description ?? title,
          priority: "medium",
          isAgent: true,
          parentSessionKey: leaderSessionKey,
        });

        // Add a taskPlan entry for this SDK subagent if not already planned
        const leaderDataNow = leader.data as LeaderData;
        const alreadyInPlan = (leaderDataNow.taskPlan ?? []).some(
          (t) => t.taskId === taskId,
        );
        if (!alreadyInPlan) {
          const agentEntry: TaskPlanItem = {
            taskId,
            title: title ?? description,
            description: description ?? "",
            priority: "medium",
            status: "running",
            executor: "minion",
            minionSessionKey: null,
            result: null,
            cost: 0,
            createdAt: Date.now(),
            completedAt: null,
            sessionSummary: "",
          };
          dispatch({
            type: "UPDATE_NODE_DATA",
            id: leader.id,
            data: {
              ...leaderDataNow,
              taskPlan: [...(leaderDataNow.taskPlan ?? []), agentEntry],
            },
          });
        }

        return;
      }

      // render_update is consumed directly by the Leader node (embedded
      // dashboard). The standalone render node was retired, so Canvas no
      // longer spawns or tracks a companion dashboard node here.
    });
  }, [socketSubscribe, leaderSessionTopicKey, dispatch, graphDispatch]);

  /** Gather context items for nodes spatially inside a context-group.
   *  Any node whose type registers `providesContext: true` is eligible —
   *  including ImageNode, not just the hand-listed legacy types.
   *  See `./context-extraction.ts` for the per-node flattener. */
  const getContextFromGroup = useCallback((groupNode: CanvasNode): ContextItem[] => {
    const items: ContextItem[] = [];
    for (const n of nodes) {
      if (n.id === groupNode.id) continue;
      if (!isContextProvider(n.type)) continue;
      if (!isInsideGroup(n, groupNode)) continue;
      const item = extractContextItem(n);
      if (item) items.push(item);
    }
    return items;
  }, [nodes, isInsideGroup]);

  const getContextForNode = useCallback((nodeId: string): ContextItem[] => {
    const targetNode = nodes.find((n) => n.id === nodeId);

    // If this IS a context-group, return its spatially contained items
    if (targetNode?.type === "context-group") {
      return getContextFromGroup(targetNode);
    }

    // Otherwise follow context edges (normal path for leaders)
    const contextEdges = graph.edges.filter(
      (e) => e.targetNodeId === nodeId && e.protocol === "context",
    );

    const items: ContextItem[] = [];
    for (const edge of contextEdges) {
      const sourceNode = nodes.find((n) => n.id === edge.sourceNodeId);
      if (!sourceNode) continue;

      // Context groups: resolve by spatial containment
      if (sourceNode.type === "context-group") {
        items.push(...getContextFromGroup(sourceNode));
        continue;
      }

      // Leader→leader "lean"/"full": forward the upstream leader's session
      // transcript instead of its flattened dashboard ("dashboard" = default).
      if (
        sourceNode.type === "leader" &&
        (edge.contextMode === "lean" || edge.contextMode === "full")
      ) {
        const leaderItem = resolveLeaderContextItem(sourceNode, edge.contextMode);
        if (leaderItem) items.push(leaderItem);
        continue;
      }

      const item = extractContextItem(sourceNode);
      if (item) items.push(item);
    }
    return items;
  }, [nodes, graph, extractContextItem, getContextFromGroup]);

  // Stable per-node getters: closures are created once per node ID and reused
  // across renders (ref indirection keeps them pointed at the latest compute).
  const getStableContextGetter = useStableNodeGetter(getContextForNode);

  // Per-edge context modes feeding a node (for leader→leader preamble framing).
  const getIncomingContextModes = useCallback(
    (nodeId: string): string[] =>
      graph.edges
        .filter((e) => e.targetNodeId === nodeId && e.protocol === "context")
        .map((e) => e.contextMode ?? "dashboard"),
    [graph],
  );
  const getStableIncomingModesGetter = useStableNodeGetter(getIncomingContextModes);

  // ── Multi-select context group action ──────────────────
  // When only context-compatible nodes are selected, compute whether we
  // can offer a "Group as Context" action.
  const CONTEXT_NODE_TYPES = useMemo(() => new Set(["markdown", "note", "file-viewer"]), []);

  const multiSelectInfo = useMemo(() => {
    if (selectedIds.size < 2) return null;
    const selectedNodes = nodes.filter((n) => selectedIds.has(n.id));
    if (selectedNodes.length < 2) return null;

    const allContext = selectedNodes.every((n) => CONTEXT_NODE_TYPES.has(n.type));
    if (!allContext) return null;

    // Check if all selected nodes are already in the same context group
    const groups = nodes.filter((n) => n.type === "context-group");
    let sharedGroupId: string | null = null;
    let allInSameGroup = false;

    for (const group of groups) {
      const allInside = selectedNodes.every((n) => isInsideGroup(n, group));
      if (allInside) {
        sharedGroupId = group.id;
        allInSameGroup = true;
        break;
      }
    }

    // Compute bounding box of selected nodes (in world coords) for positioning
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of selectedNodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + n.size.width);
      maxY = Math.max(maxY, n.position.y + n.size.height);
    }

    return {
      nodes: selectedNodes,
      allInSameGroup,
      sharedGroupId,
      bounds: { minX, minY, maxX, maxY },
    };
  }, [selectedIds, nodes, CONTEXT_NODE_TYPES, isInsideGroup]);

  /** Create a context group containing all currently selected context nodes */
  const groupSelectedAsContext = useCallback(() => {
    if (!multiSelectInfo || multiSelectInfo.allInSameGroup) return;
    const { nodes: selectedNodes, bounds } = multiSelectInfo;

    // Create a context group sized to contain all selected nodes
    const groupId = generateId();
    const groupX = bounds.minX - GROUP_PAD;
    const groupY = bounds.minY - GROUP_HEADER - GROUP_PAD;
    const groupW = Math.max(GROUP_MIN_W, bounds.maxX - bounds.minX + GROUP_PAD * 2);
    const groupH = Math.max(GROUP_MIN_H, bounds.maxY - bounds.minY + GROUP_HEADER + GROUP_PAD * 2);

    dispatch({
      type: "ADD_NODE",
      node: {
        id: groupId,
        type: "context-group",
        position: { x: groupX, y: groupY },
        size: { width: groupW, height: groupH },
        data: { name: "" },
      },
    });

    // Move nodes inside the group frame so the auto-layout picks them up.
    // Center-align horizontally, stack vertically inside the group.
    const contentX = groupX + GROUP_PAD;
    let cursorY = groupY + GROUP_HEADER + GROUP_PAD;
    const sorted = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);
    const moves: Array<{ id: string; position: Position }> = [];
    for (const n of sorted) {
      moves.push({ id: n.id, position: { x: contentX, y: cursorY } });
      cursorY += n.size.height + GROUP_GAP;
    }
    if (moves.length > 0) {
      dispatch({ type: "MOVE_GROUP", moves });
    }

    // Fit the group to the actual stacked height
    const totalH = cursorY - GROUP_GAP - groupY;
    const finalH = Math.max(GROUP_MIN_H, totalH + GROUP_PAD);
    dispatch({ type: "RESIZE_NODE", id: groupId, size: { width: groupW, height: finalH } });

    // Select just the new group
    setSelectedIds(new Set([groupId]));
  }, [multiSelectInfo, dispatch]);

  // ── General multi-select bounding box (for all node types) ──
  const multiSelectBounds = useMemo(() => {
    if (selectedIds.size < 2) return null;
    const selected = nodes.filter((n) => selectedIds.has(n.id));
    if (selected.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of selected) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + n.size.width);
      maxY = Math.max(maxY, n.position.y + n.size.height);
    }
    return { minX, minY, maxX, maxY, count: selected.length };
  }, [selectedIds, nodes]);

  // Compute the screen position for the floating action bar
  const multiSelectActionPos = useMemo(() => {
    // Use context-specific info if available, else general bounds
    const bounds = multiSelectInfo?.bounds ?? multiSelectBounds;
    if (!bounds) return null;
    const screenX = (bounds.minX + bounds.maxX) / 2 * transform.scale + transform.x;
    const screenY = bounds.minY * transform.scale + transform.y - 12;
    return { x: screenX, y: screenY };
  }, [multiSelectInfo, multiSelectBounds, transform]);

  // ── Stable derived values for CanvasNodeComponent props ──
  // Memoize these so they don't create new identities on every render,
  // which would defeat React.memo on the node components.
  const isDragActive = connectionDrag !== null;
  const snapTargetKey = useMemo(
    () =>
      connectionDrag?.snapTarget
        ? `${connectionDrag.snapTarget.nodeId}:${connectionDrag.snapTarget.portId}`
        : undefined,
    [connectionDrag?.snapTarget?.nodeId, connectionDrag?.snapTarget?.portId],
  );
  const pendingDashboardDrop = useMemo(() => {
    if (!dashboardDropMenu) return null;
    const sourceNode = nodes.find((n) => n.id === dashboardDropMenu.source.nodeId);
    if (!sourceNode) return null;

    const sourcePort = getPortWorldPos(
      sourceNode,
      dashboardDropMenu.source.portId,
      "output",
    );
    if (!sourcePort) return null;

    const placement = dashboardDropMenu.placement;

    return {
      sourcePort,
      targetPort: placement.targetPort,
      position: placement.position,
      size: placement.size,
      color:
        PROTOCOL_COLORS[dashboardDropMenu.source.protocol] ??
        "var(--edge-context)",
    };
  }, [dashboardDropMenu, nodes]);
  const dashboardDropMenuPosition = useMemo(() => {
    if (!dashboardDropMenu) return null;
    if (!pendingDashboardDrop) {
      return { x: dashboardDropMenu.screenX, y: dashboardDropMenu.screenY };
    }

    const rect = containerRef.current?.getBoundingClientRect();
    return {
      x:
        (rect?.left ?? 0) +
        pendingDashboardDrop.position.x * transform.scale +
        transform.x +
        14,
      y:
        (rect?.top ?? 0) +
        pendingDashboardDrop.position.y * transform.scale +
        transform.y +
        14,
    };
  }, [dashboardDropMenu, pendingDashboardDrop, transform]);

  return (
    <div
      ref={containerRef}
      className="canvas-root"
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleCanvasMouseMove}
      onContextMenu={handleCanvasContextMenu}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleFileDrop}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        // Prevent browser from handling touch gestures (pan, zoom) natively.
        // We manage all canvas interactions via JS wheel/pointer handlers.
        touchAction: "none",
        // Prevent accidental text selection during canvas interactions
        // (marquee, shift-click, panning). Interactive elements inside
        // nodes re-enable selection via the CSS rule below.
        userSelect: "none",
        WebkitUserSelect: "none",
        cursor: isPanning
          ? "grabbing"
          : spaceRef.current
            ? "grab"
            : "default",
      }}
    >
      <CanvasBackground transform={transform} />

      {nodes.length === 0 && (
        <EmptyCanvasState onStart={startFromEmptyCanvas} />
      )}

      {/* ── File drop overlay ── */}
      {isDragOverCanvas && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(192, 132, 252, 0.08)",
            border: "2px dashed rgba(192, 132, 252, 0.5)",
            borderRadius: 12,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "var(--bg-secondary)",
              padding: "16px 32px",
              borderRadius: 12,
              border: "1px solid rgba(192, 132, 252, 0.3)",
              boxShadow: "var(--shadow-lg)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 24 }}>+</span>
            <span
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                fontFamily: "var(--font-sans)",
              }}
            >
              Drop to create file viewer
            </span>
          </div>
        </div>
      )}

      {/* ── Marquee selection rectangle ── */}
      {marquee && (
        <div
          style={{
            position: "fixed",
            left: Math.min(marquee.startX, marquee.currentX),
            top: Math.min(marquee.startY, marquee.currentY),
            width: Math.abs(marquee.currentX - marquee.startX),
            height: Math.abs(marquee.currentY - marquee.startY),
            background: "rgba(192, 132, 252, 0.08)",
            border: "1px solid rgba(192, 132, 252, 0.35)",
            borderRadius: 2,
            pointerEvents: "none",
            zIndex: 300,
          }}
        />
      )}

      <SessionPanel
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
        socketConnected={socketConnected}
        projectPath={projectPath}
        onAttachSession={handleAttachSession}
        onFocusSession={handleFocusSession}
        attachedSessionKeys={attachedSessionKeys}
      />

      {commandPaletteOpen && (
        <CommandPalette
          items={commandPaletteItems}
          nodes={nodes}
          onCreate={handleCommandPaletteCreate}
          onJump={(nodeId) => {
            handleFocusNode(nodeId);
            setCommandPaletteOpen(false);
          }}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      {/* ── Right-click context menu ── */}
      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.screenX}
          y={contextMenu.screenY}
          options={contextMenuOptions}
          onSelect={handleContextMenuSelect}
          onClose={handleContextMenuClose}
        />
      )}

      {dashboardDropMenu && (
        <CanvasContextMenu
          x={dashboardDropMenuPosition?.x ?? dashboardDropMenu.screenX}
          y={dashboardDropMenuPosition?.y ?? dashboardDropMenu.screenY}
          options={dashboardDropMenuOptions}
          onSelect={handleDashboardDropMenuSelect}
          onClose={handleDashboardDropMenuClose}
          title="Use dashboard context"
        />
      )}

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          willChange: "transform",
        }}
      >
        <EdgeRenderer
          graph={graph}
          nodes={nodes}
          selectedEdgeId={selectedEdgeId}
          hoveredEdgeId={hoveredEdgeId}
          onEdgeClick={handleEdgeClick}
          onEdgeHover={handleEdgeHover}
        />

        {nodes.map((node) => (
          <CanvasNodeComponent
            key={node.id}
            node={node}
            isSelected={selectedIds.has(node.id)}
            onSelect={handleSelectNode}
            onMove={handleMoveNode}
            onUpdateData={handleUpdateNodeData}
            onResize={handleResizeNode}
            onAddContentNode={addContentNode}
            onRevealMinion={revealMinion}
            onDuplicateLeaderSetup={
              node.type === "leader" ? () => duplicateLeaderSetup(node.id) : undefined
            }
            onOpenSystemModel={
              node.type === "leader" ? () => openSystemModelForLeader(node.id) : undefined
            }
            onSaveLeaderPreset={
              node.type === "leader" ? (input) => saveLeaderPreset(node.id, input) : undefined
            }
            onFocusNode={node.type === "leader" ? handleFocusNode : undefined}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            getContextForNode={getStableContextGetter(node.id)}
            getIncomingContextModes={getStableIncomingModesGetter(node.id)}
            projectPath={projectPath}
            projectId={projectId}
            onConnectionStart={handleConnectionStart}
            onConnectionEnd={handleConnectionEnd}
            isDragActive={isDragActive}
            validTargetPorts={validTargets}
            connectedPorts={connectedPorts}
            snapTargetKey={snapTargetKey}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            isDropTarget={dropTargetGroupId === node.id}
            isBeingDragged={draggingNodeId === node.id}
            isInsideDraggingGroup={draggingGroupContainedIds.has(node.id)}
            isInsideContextGroup={nodesInsideGroups.has(node.id)}
          />
        ))}

        {/* ── Multi-select bounding box highlight (in world space) ── */}
        {multiSelectBounds && !draggingNodeId && (
          <div
            style={{
              position: "absolute",
              left: multiSelectBounds.minX - 8,
              top: multiSelectBounds.minY - 8,
              width: multiSelectBounds.maxX - multiSelectBounds.minX + 16,
              height: multiSelectBounds.maxY - multiSelectBounds.minY + 16,
              border: "1.5px dashed rgba(192, 132, 252, 0.2)",
              borderRadius: 12,
              pointerEvents: "none",
              transition: "all 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        )}
      </div>

      <NodeStatusOverlay
        nodes={nodes}
        transform={transform}
        visible={transform.scale <= LEADER_PROMPT_OVERLAY_ZOOM_THRESHOLD}
      />

      {/* ── Edge inspector ── */}
      {selectedEdge && selectedEdgeMidpoint && (
        <EdgeInspector
          edge={selectedEdge}
          screenX={selectedEdgeMidpoint.x * transform.scale + transform.x}
          screenY={selectedEdgeMidpoint.y * transform.scale + transform.y}
          sourceLabel={
            nodes.find((n) => n.id === selectedEdge.sourceNodeId)?.type ??
            "source"
          }
          targetLabel={
            nodes.find((n) => n.id === selectedEdge.targetNodeId)?.type ??
            "target"
          }
          onDelete={handleDeleteSelectedEdge}
          onFocusSource={() => handleFocusEdgeEndpoint("source")}
          onFocusTarget={() => handleFocusEdgeEndpoint("target")}
          onClose={() => setSelectedEdgeId(null)}
          staleness={selectedEdgeStaleness}
          contextMode={
            selectedEdgeIsLeaderContext
              ? {
                  current: resolveContextMode(selectedEdge.contextMode),
                  onChange: (mode) =>
                    graphDispatch({
                      type: "SET_EDGE_CONTEXT_MODE",
                      id: selectedEdge.id,
                      contextMode: mode,
                    }),
                }
              : undefined
          }
        />
      )}

      {/* Steady connector shown after dashboard context is dropped and before an action is chosen. */}
      {pendingDashboardDrop && (
        <svg
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            overflow: "visible",
            zIndex: 45,
          }}
        >
          <g
            transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}
          >
            {(() => {
              const x1 = pendingDashboardDrop.sourcePort.x;
              const y1 = pendingDashboardDrop.sourcePort.y;
              const x2 = pendingDashboardDrop.targetPort.x;
              const y2 = pendingDashboardDrop.targetPort.y;
              const dx = Math.max(80, Math.abs(x2 - x1) * 0.5);
              const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

              return (
                <>
                  <rect
                    x={pendingDashboardDrop.position.x}
                    y={pendingDashboardDrop.position.y}
                    width={pendingDashboardDrop.size.width}
                    height={pendingDashboardDrop.size.height}
                    rx={12}
                    fill="var(--bg-secondary)"
                    fillOpacity={0.2}
                    stroke={pendingDashboardDrop.color}
                    strokeWidth={1.5}
                    strokeDasharray="8 6"
                    strokeOpacity={0.55}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={pendingDashboardDrop.color}
                    strokeWidth={2.5}
                    strokeOpacity={0.72}
                    strokeDasharray="8 6"
                    className="edge-flow"
                  />
                  <circle
                    cx={x1}
                    cy={y1}
                    r={3.5}
                    fill={pendingDashboardDrop.color}
                    opacity={0.75}
                  />
                  <circle
                    className="dashboard-drop-attention"
                    cx={x2}
                    cy={y2}
                    r={9}
                    fill="none"
                    stroke={pendingDashboardDrop.color}
                    strokeWidth={2}
                  />
                  <circle
                    cx={x2}
                    cy={y2}
                    r={4}
                    fill={pendingDashboardDrop.color}
                    opacity={0.9}
                  />
                </>
              );
            })()}
          </g>
        </svg>
      )}

      {/* Connection drag preview line */}
      {connectionDrag && (
        <svg
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            overflow: "visible",
            zIndex: 50,
          }}
        >
          <g
            transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}
          >
            {(() => {
              const srcNode = nodes.find(
                (n) => n.id === connectionDrag.source.nodeId,
              );
              if (!srcNode) return null;

              const contract = getContract(srcNode.type);
              if (!contract) return null;

              // Compute source port position using port spacing
              const dir = connectionDrag.source.direction;
              const sameDirPorts = contract.ports.filter(
                (p) => p.direction === dir,
              );
              const portIndex = sameDirPorts.findIndex(
                (p) => p.id === connectionDrag.source.portId,
              );
              const srcPort = sameDirPorts[portIndex];
              const srcY = srcPort?.anchorY != null
                ? srcNode.position.y + srcNode.size.height * srcPort.anchorY
                : srcNode.position.y + srcNode.size.height / (sameDirPorts.length + 1) * (portIndex + 1);
              const srcX =
                dir === "output"
                  ? srcNode.position.x + srcNode.size.width
                  : srcNode.position.x;

              const x1 = srcX;
              const y1 = srcY;

              // Snap endpoint to nearest valid target port if within range
              const snap = connectionDrag.snapTarget;
              let x2 = connectionDrag.mouseX;
              let y2 = connectionDrag.mouseY;
              if (snap) {
                const targetDir = dir === "output" ? "input" : "output";
                const snapNode = nodes.find((n) => n.id === snap.nodeId);
                if (snapNode) {
                  const snapPos = getPortWorldPos(snapNode, snap.portId, targetDir);
                  if (snapPos) { x2 = snapPos.x; y2 = snapPos.y; }
                }
              }

              const dx = Math.abs(x2 - x1) * 0.5;
              const d = `M ${x1} ${y1} C ${x1 + (dir === "output" ? dx : -dx)} ${y1}, ${x2 + (dir === "output" ? -dx : dx)} ${y2}, ${x2} ${y2}`;

              const color =
                PROTOCOL_COLORS[connectionDrag.source.protocol] ??
                "var(--text-muted)";

              return (
                <>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={snap ? 2.5 : 2}
                    strokeOpacity={snap ? 0.85 : 0.5}
                    strokeDasharray="6 4"
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from="20"
                      to="0"
                      dur="0.6s"
                      repeatCount="indefinite"
                    />
                  </path>
                  <circle
                    cx={x1}
                    cy={y1}
                    r={4}
                    fill={color}
                    opacity={0.8}
                  />
                  {/* Endpoint dot — pulses when snapping */}
                  <circle cx={x2} cy={y2} r={snap ? 6 : 3} fill={color} opacity={snap ? 0.9 : 0.5}>
                    {snap && (
                      <animate attributeName="r" values="5;9;5" dur="0.8s" repeatCount="indefinite" />
                    )}
                  </circle>
                  {snap && (
                    <circle cx={x2} cy={y2} r={12} fill="none" stroke={color} strokeWidth={1.5} opacity={0.4}>
                      <animate attributeName="r" values="8;16;8" dur="0.8s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.5;0;0.5" dur="0.8s" repeatCount="indefinite" />
                    </circle>
                  )}
                </>
              );
            })()}
          </g>
        </svg>
      )}

      {/* ── Multi-select floating action bar ── */}
      {multiSelectActionPos && multiSelectBounds && (multiSelectInfo ? !multiSelectInfo.allInSameGroup : true) && (
        <div
          style={{
            position: "absolute",
            left: multiSelectActionPos.x,
            top: multiSelectActionPos.y,
            transform: "translate(-50%, -100%)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 6px",
            background: "var(--bg-elevated)",
            backdropFilter: "blur(12px)",
            border: "1px solid var(--border-hover)",
            borderRadius: 8,
            boxShadow: "var(--shadow-lg)",
            zIndex: 200,
            pointerEvents: "auto",
            whiteSpace: "nowrap",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span
            style={{
              fontSize: 10,
              color: "rgba(192, 132, 252, 0.6)",
              fontFamily: "var(--font-mono)",
              padding: "0 4px",
              fontWeight: 500,
            }}
          >
            {multiSelectBounds.count} selected
          </span>
          {multiSelectInfo && !multiSelectInfo.allInSameGroup && (
            <>
              <div style={{ width: 1, height: 14, background: "rgba(192, 132, 252, 0.15)" }} />
              <button
                onClick={groupSelectedAsContext}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  background: "var(--state-active)",
                  border: "1px solid var(--accent)",
                  borderRadius: 6,
                  color: "var(--accent)",
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "var(--font-sans)",
                  cursor: "pointer",
                  letterSpacing: "0.01em",
                  transition: "background 0.15s, border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(192, 132, 252, 0.22)";
                  e.currentTarget.style.borderColor = "rgba(192, 132, 252, 0.45)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(192, 132, 252, 0.12)";
                  e.currentTarget.style.borderColor = "rgba(192, 132, 252, 0.25)";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1" y="1" width="14" height="14" rx="3" strokeDasharray="3 2" />
                  <path d="M5 8h6M8 5v6" strokeLinecap="round" />
                </svg>
                Group as Context
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Context-group delete confirmation ── */}
      {pendingGroupDelete && (
        <ConfirmModal
          title="Delete Context Group"
          description={
            <>
              This group contains{" "}
              <strong>{pendingGroupDelete.containedIds.length}</strong> node
              {pendingGroupDelete.containedIds.length !== 1 ? "s" : ""}. Would
              you like to delete them as well?
            </>
          }
          actions={[
            {
              label: "Remove grouping only",
              variant: "ghost",
              onClick: () => {
                for (const id of [...pendingGroupDelete.groupIds, ...pendingGroupDelete.otherIds]) {
                  const removed = nodes.find((node) => node.id === id);
                  if (removed) removeCanvasNode(removed);
                  dispatch({ type: "REMOVE_NODE", id });
                  graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: id });
                }
                setSelectedIds(new Set());
                setPendingGroupDelete(null);
              },
            },
            {
              label: "Delete all",
              variant: "danger",
              onClick: () => {
                const all = [
                  ...pendingGroupDelete.groupIds,
                  ...pendingGroupDelete.containedIds,
                  ...pendingGroupDelete.otherIds,
                ];
                for (const id of all) {
                  const removed = nodes.find((node) => node.id === id);
                  if (removed) removeCanvasNode(removed);
                  dispatch({ type: "REMOVE_NODE", id });
                  graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: id });
                }
                setSelectedIds(new Set());
                setPendingGroupDelete(null);
              },
            },
          ]}
          onClose={() => setPendingGroupDelete(null)}
        />
      )}

      <ViewportOverlay zIndex={850}>
        {/* Connection indicator */}
        <div
          style={{
            position: "absolute",
            top: viewportTopOffset + 12,
            right: 16,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            pointerEvents: "auto",
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: socketConnected ? "var(--success-color)" : "var(--danger-color)",
              boxShadow: socketConnected ? "0 0 6px var(--success-color)" : "none",
            }}
          />
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {socketConnected ? "Connected" : "Disconnected"}
          </span>
        </div>

        <Toolbar
          transform={transform}
          onZoomIn={() => zoomTo(transform.scale * 1.1)}
          onZoomOut={() => zoomTo(transform.scale / 1.1)}
          onZoomReset={() =>
            setTransform((p) => ({
              ...p,
              scale: 1,
              x:
                containerRef.current
                  ? containerRef.current.clientWidth / 2 -
                    (containerRef.current.clientWidth / 2 - p.x) /
                      p.scale
                  : 0,
              y:
                containerRef.current
                  ? containerRef.current.clientHeight / 2 -
                    (containerRef.current.clientHeight / 2 - p.y) /
                      p.scale
                  : 0,
            }))
          }
          onFitView={fitView}
          onFocusSelected={() => focusNodes(selectedIds)}
          hasSelection={selectedIds.size > 0}
          onAddNode={addNode}
          onTidyLayout={handleTidyLayout}
          onFocusNextActive={focusNextActive}
          hasActiveNodes={activeNodeIds.length > 0}
        />
      </ViewportOverlay>
      <CanvasMiniMap
        nodes={nodes}
        edges={graph.edges}
        transform={transform}
        setTransform={setTransform}
        containerRef={containerRef}
        selectedIds={selectedIds}
        activeNodeIds={activeNodeIdSet}
        onFitView={fitView}
        onFocusSelected={() => focusNodes(selectedIds)}
        hasSelection={selectedIds.size > 0}
        onZoomTo={zoomTo}
      />
    </div>
  );
}
