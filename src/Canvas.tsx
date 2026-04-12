import {
  memo,
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type Dispatch,
} from "react";
import type { CanvasTransform, CanvasNode, CanvasAction, Position, Size, ContextItem } from "./types.ts";
import { generateId } from "./canvas-state.ts";
import { CanvasNodeComponent } from "./CanvasNode.tsx";
import { getAllNodeTypes } from "./node-registry.ts";
import { SessionPanel } from "./SessionPanel.tsx";
import { EdgeRenderer } from "./EdgeRenderer.tsx";
import type { GraphDocument } from "./graph.ts";
import { getContract, canConnect, canAcceptContextConnection, LEADER_CONTRACT } from "./graph.ts";
import type { GraphAction } from "./graph-runtime.ts";
import { createEdge } from "./graph-runtime.ts";
import type { PortInfo } from "./components/PortDot.tsx";
import { PROTOCOL_COLORS } from "./components/PortDot.tsx";
import type { LeaderData, TaskPlanItem } from "./nodes/LeaderNode.tsx";
import type { MinionData, MinionTaskState } from "./nodes/MinionNode.tsx";
import type { RenderNodeData } from "./nodes/RenderNode.tsx";
import { emptyRenderState } from "./render-dsl.ts";
import { CanvasContextMenu } from "./components/CanvasContextMenu.tsx";
import type { ContextMenuOption } from "./components/CanvasContextMenu.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { createDefaultNodeData } from "./node-defaults.ts";
import { useCanvasKeyboard } from "./use-canvas-keyboard.ts";
import { useCanvasFileDrop } from "./use-canvas-file-drop.ts";
import { findNonOverlappingPosition, viewportCenter, pushNodesFromRect, snapToGrid } from "./canvas-utils.ts";
import { computeAutoLayout } from "./auto-layout.ts";

const MIN_ZOOM = 0.1;

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
const MAX_ZOOM = 5;
const GRID_SIZE = 24;

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
  const visiblePorts = contract.ports.filter(
    (p) => p.direction === direction && !p.hidden,
  );
  const idx = visiblePorts.findIndex((p) => p.id === portId);
  if (idx === -1) return null;
  const anchorY = visiblePorts[idx].anchorY;
  const y =
    anchorY != null
      ? node.position.y + node.size.height * anchorY
      : node.position.y + (node.size.height / (visiblePorts.length + 1)) * (idx + 1);
  const x =
    direction === "output"
      ? node.position.x + node.size.width
      : node.position.x;
  return { x, y };
}

const DotGrid = memo(function DotGrid({ transform }: { transform: CanvasTransform }) {
  const dotSpacing = GRID_SIZE * transform.scale;
  const offsetX = (transform.x % dotSpacing + dotSpacing) % dotSpacing;
  const offsetY = (transform.y % dotSpacing + dotSpacing) % dotSpacing;

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <defs>
        <pattern
          id="dot-grid"
          width={dotSpacing}
          height={dotSpacing}
          patternUnits="userSpaceOnUse"
          x={offsetX}
          y={offsetY}
        >
          <circle
            cx={1}
            cy={1}
            r={1}
            fill="var(--dot-grid)"
            opacity={Math.min(1, transform.scale)}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  );
});

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
      }}
    >
      <button
        style={{
          ...btnStyle,
          background: "var(--accent)",
          color: "var(--text-primary)",
          border: "none",
          fontWeight: 600,
          width: "auto",
          padding: "0 10px",
          fontSize: 12,
          gap: 4,
        }}
        onClick={() => onAddNode("leader")}
        title="Add Leader node"
      >
        + Leader
      </button>
      <button
        style={{
          ...btnStyle,
          background: "var(--bg-surface)",
          color: "var(--text-secondary)",
          fontWeight: 500,
          width: "auto",
          padding: "0 10px",
          fontSize: 12,
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
        + Markdown
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
  socketSubscribe?: (fn: (msg: unknown) => void) => () => void;
  socketConnected?: boolean;
  projectPath?: string;
  projectSettings?: import("./api.ts").ProjectSettings;
  undo?: () => void;
  redo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** When set, auto-selects this node (then clear it) */
  focusNodeId?: string | null;
  onFocusNodeHandled?: () => void;
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
  projectSettings,
  undo,
  redo,
  canUndo,
  canRedo,
  focusNodeId,
  onFocusNodeHandled,
}: CanvasProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
    () => [
      { label: "New Leader", type: "leader" },
      { label: "New Markdown", type: "markdown" },
    ],
    [],
  );

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

  // ── Node drag tracking (for context-group drop feedback) ──
  /** Which node is currently being dragged by the user, null when idle */
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const draggingNodeIdRef = useRef<string | null>(null);
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
    worktreeBranch?: string | null;
    isAgent?: boolean;
    parentSessionKey?: string;
  }
  const pendingMinionsRef = useRef<Map<string, PendingMinionSpawn>>(new Map());
  const revealedMinionsRef = useRef<Set<string>>(new Set());
  const spawnedMinionsRef = useRef<Set<string>>(new Set());
  const spawnedRenderNodesRef = useRef<Set<string>>(new Set());

  const handleDragStart = useCallback((nodeId: string) => {
    draggingNodeIdRef.current = nodeId;
    setDraggingNodeId(nodeId);

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
  }, [isInsideGroup]);

  const handleDragEnd = useCallback((nodeId: string) => {
    const targetGroupId = dropTargetGroupIdRef.current;
    draggingNodeIdRef.current = null;
    dragGroupContainedIdsRef.current = new Map();
    setDraggingNodeId(null);
    setDropTargetGroupId(null);

    // If the visual drop target was active, snap the node so its center
    // lands inside the group. The existing restack effect (debounced) will
    // then arrange it in the proper stacked layout.
    if (targetGroupId) {
      const draggedNode = nodesRef.current.find((n) => n.id === nodeId);
      const group = nodesRef.current.find((n) => n.id === targetGroupId);
      if (draggedNode && group) {
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
        }
      }
    }
  }, [dispatch]);

  // Keep refs to nodes, transform, and selection so callbacks can access latest
  // state without needing them in dependency arrays (which would defeat memoization).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const projectSettingsRef = useRef(projectSettings);
  projectSettingsRef.current = projectSettings;

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

      const defaultData = createDefaultNodeData(nodeType);
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

  // Compute which session keys are already on the canvas (any node type with a sessionKey)
  const attachedSessionKeys = useMemo(
    () =>
      new Set(
        nodes
          .filter((n) => n.type === "claude-session" || n.type === "leader" || n.type === "minion")
          .map((n) => (n.data as { sessionKey?: string | null }).sessionKey)
          .filter((k): k is string => k != null),
      ),
    [nodes],
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

      // Compute bounding box of all target nodes
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of targets) {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + n.size.width);
        maxY = Math.max(maxY, n.position.y + n.size.height);
      }

      const padding = 80;
      const contentW = maxX - minX + padding * 2;
      const contentH = maxY - minY + padding * 2;
      const scaleX = container.clientWidth / contentW;
      const scaleY = container.clientHeight / contentH;
      // Fit the node(s) in viewport but clamp to a comfortable range:
      // - At least 0.4 so you can read text
      // - At most 1.0 so it doesn't zoom in absurdly on small nodes
      const scale = Math.min(1.0, Math.max(0.4, Math.min(scaleX, scaleY)));

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      setTransform({
        x: container.clientWidth / 2 - centerX * scale,
        y: container.clientHeight / 2 - centerY * scale,
        scale,
      });
    },
    [nodes, setTransform],
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

  // Track which active node we last focused, to cycle through them
  const lastActiveIndexRef = useRef(-1);

  const focusNextActive = useCallback(() => {
    if (activeNodeIds.length === 0) return;
    // Advance to the next active node (wrapping around)
    let nextIndex = lastActiveIndexRef.current + 1;
    if (nextIndex >= activeNodeIds.length) nextIndex = 0;
    lastActiveIndexRef.current = nextIndex;
    const id = activeNodeIds[nextIndex];
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
      console.log(`[Canvas] revealMinion called with key: ${minionSessionKey}`);
      console.log(`[Canvas] pendingMinions keys:`, [...pendingMinionsRef.current.keys()]);

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
        console.warn(`[Canvas] revealMinion: no data found for ${minionSessionKey}`);
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

      // Account for existing dashboard node — minions start to the right
      // of the dashboard if one exists, otherwise to the right of the leader.
      const existingRender = nodesRef.current.find(
        (n) => n.type === "render" && (n.data as RenderNodeData).leaderId === leader.id,
      );
      const anchorRight = existingRender
        ? existingRender.position.x + existingRender.size.width
        : leader.position.x + leader.size.width;

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
        model: "sonnet" as const,
        permissionMode: "bypassPermissions" as const,
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

      console.log(`[Canvas] Minion revealed: ${minionSessionKey} for task "${spawn.title}"`);
    },
    [dispatch, graphDispatch, setTransform],
  );

  // Keyboard shortcuts: space (pan), delete, undo/redo
  useCanvasKeyboard({
    selectedIds,
    setSelectedIds,
    nodes,
    graph,
    dispatch,
    graphDispatch,
    spaceRef,
    isInsideGroup,
    setPendingGroupDelete,
    focusNodes,
    focusNextActive,
    undo,
    redo,
  });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setTransform((prev) => {
      const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;
      const newScale = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, prev.scale * zoomFactor),
      );
      const scaleChange = newScale / prev.scale;
      return {
        x: mouseX - (mouseX - prev.x) * scaleChange,
        y: mouseY - (mouseY - prev.y) * scaleChange,
        scale: newScale,
      };
    });
  }, [setTransform]);

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Close context menu on any mouse down
      setContextMenu(null);

      if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
        e.preventDefault();
        setIsPanning(true);
        panRef.current = { startX: e.clientX, startY: e.clientY };

        const handleMouseMove = (ev: MouseEvent) => {
          if (!panRef.current) return;
          const dx = ev.clientX - panRef.current.startX;
          const dy = ev.clientY - panRef.current.startY;
          panRef.current = { startX: ev.clientX, startY: ev.clientY };
          setTransform((prev) => ({
            ...prev,
            x: prev.x + dx,
            y: prev.y + dy,
          }));
        };

        const handleMouseUp = () => {
          panRef.current = null;
          setIsPanning(false);
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
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
            // Simple click on empty canvas → deselect all
            setSelectedIds(new Set());
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
    [setTransform],
  );

  const handleSelectNode = useCallback(
    (id: string, additive: boolean) => {
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
            // Leader → drag attached minions and render nodes
            for (const n of nodesRef.current) {
              if (
                (n.type === "minion" && (n.data as MinionData).leaderId === selId) ||
                (n.type === "render" && (n.data as RenderNodeData).leaderId === selId)
              ) {
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
        // Leader drags its minions and affixed render nodes
        const attached = nodesRef.current.filter(
          (n) =>
            (n.type === "minion" &&
              (n.data as MinionData).leaderId === currentNode.id) ||
            (n.type === "render" &&
              (n.data as RenderNodeData).leaderId === currentNode.id),
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

      // When a Leader's sessionKey changes, update any existing render node
      // (but don't create one — that happens on first render_update message)
      const leaderNode = nodesRef.current.find((n) => n.id === id);
      if (leaderNode?.type === "leader") {
        const prev = leaderNode.data as LeaderData;
        const next = data as LeaderData;
        if (prev.sessionKey !== next.sessionKey && next.sessionKey) {
          const existing = nodesRef.current.find(
            (n) => n.type === "render" && (n.data as RenderNodeData).leaderId === id,
          );
          if (existing) {
            // Update existing render node with new session key and clear stale state
            dispatch({
              type: "UPDATE_NODE_DATA",
              id: existing.id,
              data: {
                ...(existing.data as RenderNodeData),
                leaderSessionKey: next.sessionKey,
                renderState: emptyRenderState(),
              },
            });
          }
        }
      }
    },
    [dispatch],
  );

  const handleResizeNode = useCallback(
    (id: string, size: Size) => {
      dispatch({ type: "RESIZE_NODE", id, size });

      // When a Leader node is resized, push its companion render node so it
      // stays flush to the right edge (no overlap).
      const currentNode = nodesRef.current.find((n) => n.id === id);
      if (currentNode?.type === "leader") {
        const renderNode = nodesRef.current.find(
          (n) =>
            n.type === "render" &&
            (n.data as RenderNodeData).leaderId === id,
        );
        if (renderNode) {
          const GAP = 16; // same gap used when spawning the render node
          const newRenderX = currentNode.position.x + size.width + GAP;

          // Clamp the render node's Y so it stays within the leader's
          // vertical extent. If the dashboard is taller than the leader,
          // just top-align.
          const leaderTop = currentNode.position.y;
          const leaderBottom = leaderTop + size.height;
          const renderH = renderNode.size.height;
          const minY = leaderTop;
          const maxY = Math.max(leaderTop, leaderBottom - renderH);
          const clampedY = Math.min(Math.max(renderNode.position.y, minY), maxY);

          if (
            renderNode.position.x !== newRenderX ||
            renderNode.position.y !== clampedY
          ) {
            dispatch({
              type: "MOVE_NODE",
              id: renderNode.id,
              position: { x: newRenderX, y: clampedY },
            });
          }
        }
      }
    },
    [dispatch],
  );

  // ── Connection drag handlers ────────────────────────────

  const handleConnectionStart = useCallback(
    (port: PortInfo, e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Read current values from refs so this callback stays stable
      const currentTransform = transformRef.current;
      const currentNodes = nodesRef.current;

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
          if (p.hidden) continue;
          // If source is output, target must be input (and vice versa)
          let valid = false;
          if (port.direction === "output" && p.direction === "input") {
            valid = canConnect(port.nodeType, port.portId, node.type, p.id);
            if (valid && p.protocol === "context") {
              valid = canAcceptContextConnection(node.type, p.id, node.data);
            }
          } else if (port.direction === "input" && p.direction === "output") {
            valid = canConnect(node.type, p.id, port.nodeType, port.portId);
            if (valid && port.protocol === "context") {
              valid = canAcceptContextConnection(port.nodeType, port.portId,
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
            if (p.hidden) continue;
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
        // Auto-complete connection if cursor is near a valid port
        const snap = snapTargetRef.current;
        if (snap) {
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
            console.log(`[Canvas] Edge created (snap): ${srcNodeId}:${srcPortId} → ${tgtNodeId}:${tgtPortId}`);
          }
        } else if (port.direction === "output") {
          // Dropped on empty canvas from an output port — create a Leader node
          // and auto-connect if there's a compatible input port on the Leader.
          const compatiblePort = LEADER_CONTRACT.ports.find(
            (p) => p.direction === "input" && p.protocol === port.protocol,
          );
          if (compatiblePort) {
            const cont = containerRef.current;
            if (cont) {
              const t = transformRef.current;
              const rect = cont.getBoundingClientRect();
              const dropX = (upEvent.clientX - rect.left - t.x) / t.scale;
              const dropY = (upEvent.clientY - rect.top - t.y) / t.scale;

              const allTypes = getAllNodeTypes();
              const leaderDef = allTypes.find((td) => td.type === "leader");
              if (leaderDef) {
                const leaderData = createDefaultNodeData("leader", projectSettingsRef.current);

                const rawX = dropX - leaderDef.defaultSize.width / 2;
                const rawY = dropY - leaderDef.defaultSize.height / 2;
                const position = findNonOverlappingPosition(
                  rawX, rawY,
                  leaderDef.defaultSize.width, leaderDef.defaultSize.height,
                  nodesRef.current,
                );

                const newNode: CanvasNode = {
                  id: generateId(),
                  type: "leader",
                  position,
                  size: { ...leaderDef.defaultSize },
                  data: leaderData,
                };
                dispatch({ type: "ADD_NODE", node: newNode });
                setSelectedIds(new Set([newNode.id]));

                // Create edge from source output to new Leader's compatible input
                const newEdge = createEdge(
                  port.nodeId, port.portId, port.nodeType,
                  newNode.id, compatiblePort.id, "leader",
                  leaderData,
                );
                if (newEdge) {
                  graphDispatch({ type: "ADD_EDGE", edge: newEdge });
                  console.log(`[Canvas] Edge created (drop-to-create): ${port.nodeId}:${port.portId} → ${newNode.id}:${compatiblePort.id}`);
                }
              }
            }
          }
        }

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
    [graphDispatch],
  );

  const handleConnectionEnd = useCallback(
    (targetPort: PortInfo) => {
      const drag = connectionDragRef.current;
      if (!drag) return;
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
        console.log(`[Canvas] Edge created: ${srcNodeId}:${srcPortId} → ${tgtNodeId}:${tgtPortId}`);
      }

      // Clean up drag state (mouseup handler will also fire)
      setConnectionDrag(null);
      setValidTargets(EMPTY_VALID_TARGETS);
    },
    [graphDispatch],
  );

  const addNode = useCallback(
    (type: string) => {
      const allTypes = getAllNodeTypes();
      const typeDef = allTypes.find((t) => t.type === type);
      if (!typeDef) return;

      const t = transformRef.current;
      const container = containerRef.current;
      const centerX = container
        ? (container.clientWidth / 2 - t.x) / t.scale
        : 400;
      const centerY = container
        ? (container.clientHeight / 2 - t.y) / t.scale
        : 300;

      const defaultData = createDefaultNodeData(type, projectSettingsRef.current);

      const rawX = centerX - typeDef.defaultSize.width / 2;
      const rawY = centerY - typeDef.defaultSize.height / 2;
      const position = findNonOverlappingPosition(
        rawX,
        rawY,
        typeDef.defaultSize.width,
        typeDef.defaultSize.height,
        nodesRef.current,
      );

      const node: CanvasNode = {
        id: generateId(),
        type,
        position,
        size: { ...typeDef.defaultSize },
        data: defaultData,
      };
      dispatch({ type: "ADD_NODE", node });
      setSelectedIds(new Set([node.id]));

      // Focus viewport on the newly added node
      if (container) {
        const padding = 80;
        const minX = position.x;
        const minY = position.y;
        const maxX = position.x + typeDef.defaultSize.width;
        const maxY = position.y + typeDef.defaultSize.height;
        const contentW = maxX - minX + padding * 2;
        const contentH = maxY - minY + padding * 2;
        const scaleX = container.clientWidth / contentW;
        const scaleY = container.clientHeight / contentH;
        const scale = Math.min(1.0, Math.max(0.4, Math.min(scaleX, scaleY)));
        const nodeCenterX = (minX + maxX) / 2;
        const nodeCenterY = (minY + maxY) / 2;
        setTransform({
          x: container.clientWidth / 2 - nodeCenterX * scale,
          y: container.clientHeight / 2 - nodeCenterY * scale,
          scale,
        });
      }
    },
    [dispatch, setTransform],
  );

  /** Add a node at a specific world position (used by context menu) */
  const addNodeAtPosition = useCallback(
    (type: string, worldX: number, worldY: number) => {
      const allTypes = getAllNodeTypes();
      const typeDef = allTypes.find((t) => t.type === type);
      if (!typeDef) return;

      const defaultData = createDefaultNodeData(type, projectSettingsRef.current);

      const rawX = worldX - typeDef.defaultSize.width / 2;
      const rawY = worldY - typeDef.defaultSize.height / 2;
      const position = findNonOverlappingPosition(
        rawX,
        rawY,
        typeDef.defaultSize.width,
        typeDef.defaultSize.height,
        nodesRef.current,
      );

      const node: CanvasNode = {
        id: generateId(),
        type,
        position,
        size: { ...typeDef.defaultSize },
        data: defaultData,
      };
      dispatch({ type: "ADD_NODE", node });
      setSelectedIds(new Set([node.id]));
    },
    [dispatch],
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
    const center = viewportCenter(transform);
    const moves = computeAutoLayout(nodes, graph.edges, { center });
    if (moves.length > 0) {
      dispatch({ type: "MOVE_GROUP", moves });
    }
  }, [nodes, graph.edges, transform, dispatch]);

  // ── Handle server-side minion_spawned + agent_spawned events ──
  // Instead of auto-creating minion nodes, we store spawn data so the
  // user can reveal minions on demand from the leader's task plan UI.
  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as { type: string; [key: string]: unknown };

      // ── task_plan_update — authoritative plan state from server ──
      // Fires on plan_task, assign_task, and complete_task. Merges server
      // task records into the leader's taskPlan, preserving any
      // frontend-only fields (cost, sessionSummary) accumulated at close.
      if (serverMsg.type === "task_plan_update") {
        const { leaderSessionKey, tasks } = serverMsg as {
          leaderSessionKey: string;
          tasks: Array<{
            taskId: string;
            title: string;
            description: string;
            priority: "low" | "medium" | "high" | "critical";
            executor: "leader" | "minion";
            minionSessionKey: string | null;
            status: "planned" | "running" | "completed" | "failed";
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
          };
        });

        dispatch({
          type: "UPDATE_NODE_DATA",
          id: leader.id,
          data: { ...leaderData, taskPlan: newPlan },
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
        } = serverMsg as {
          leaderSessionKey: string;
          minionSessionKey: string;
          taskId: string;
          title: string;
          description: string;
          priority: "low" | "medium" | "high" | "critical";
          worktreeBranch?: string | null;
        };

        if (spawnedMinionsRef.current.has(minionSessionKey)) return;
        spawnedMinionsRef.current.add(minionSessionKey);

        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) {
          console.warn(`[Canvas] minion_spawned: leader session ${leaderSessionKey} not found on canvas`);
          return;
        }

        // Store spawn data — node created on demand via revealMinion
        pendingMinionsRef.current.set(minionSessionKey, {
          leaderNodeId: leader.id,
          minionSessionKey,
          taskId,
          title,
          description,
          priority,
          worktreeBranch,
        });

        console.log(`[Canvas] Minion registered (pending reveal): ${minionSessionKey} for task "${title}" (${taskId})`);
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
        } = serverMsg as {
          leaderSessionKey: string;
          taskId: string;
          title: string;
          description: string;
        };

        const dedupKey = `agent-${taskId}`;
        if (spawnedMinionsRef.current.has(dedupKey)) return;
        spawnedMinionsRef.current.add(dedupKey);

        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) {
          console.warn(`[Canvas] agent_spawned: leader session ${leaderSessionKey} not found on canvas`);
          return;
        }

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

        console.log(`[Canvas] Agent subagent registered (pending reveal) for task "${title}" (${taskId})`);
        return;
      }

      // ── render_update — spawn RenderNode on first dashboard message ──
      // The render node is NOT created when the leader session starts; it only
      // appears once the leader actually calls a render tool (render_set, etc.).
      if (serverMsg.type === "render_update") {
        const { leaderSessionKey } = serverMsg as { leaderSessionKey: string };

        // Find the leader node that owns this session
        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) return;

        // Dedup guard: prevent duplicate spawns from rapid render_update
        // messages arriving before the first ADD_NODE dispatch is reflected
        // in nodesRef (same pattern as spawnedMinionsRef for minion nodes).
        if (spawnedRenderNodesRef.current.has(leader.id)) return;

        // If a render node already exists for this leader, nothing to do —
        // the RenderNode component's own socketSubscribe handles the update.
        const existing = nodesRef.current.find(
          (n) => n.type === "render" && (n.data as RenderNodeData).leaderId === leader.id,
        );
        if (existing) return;

        // Mark as spawned BEFORE dispatching to close the race window.
        spawnedRenderNodesRef.current.add(leader.id);

        // First render_update for this leader — spawn the render node
        const renderTypeDef = getAllNodeTypes().find((t) => t.type === "render");
        if (renderTypeDef) {
          const renderX = snapToGrid(leader.position.x + leader.size.width + 16);
          const renderY = snapToGrid(leader.position.y);
          const renderSize = { ...renderTypeDef.defaultSize };
          const renderId = generateId();

          const renderNode: CanvasNode = {
            id: renderId,
            type: "render",
            position: { x: renderX, y: renderY },
            size: renderSize,
            data: {
              leaderSessionKey,
              leaderId: leader.id,
              renderState: emptyRenderState(),
            } satisfies RenderNodeData,
          };
          dispatch({ type: "ADD_NODE", node: renderNode });

          // Push any minion nodes that overlap the new dashboard to the right
          const minionNodes = nodesRef.current.filter(
            (n) => n.type === "minion" && (n.data as MinionData).leaderId === leader.id,
          );
          if (minionNodes.length > 0) {
            const moves = pushNodesFromRect(
              { x: renderX, y: renderY, width: renderSize.width, height: renderSize.height },
              minionNodes,
              new Set([renderId, leader.id]),
              "right",
            );
            if (moves.length > 0) {
              dispatch({ type: "MOVE_GROUP", moves });
            }
          }

          console.log(`[Canvas] RenderNode spawned for leader ${leader.id} on first render_update`);
        }
        return;
      }
    });
  }, [socketSubscribe, dispatch, graphDispatch]);

  /** Extract a ContextItem from a single context-providing node. */
  const extractContextItem = useCallback((sourceNode: CanvasNode): ContextItem | null => {
    let content = "";
    let label = "";

    if (sourceNode.type === "markdown") {
      const mdData = sourceNode.data as { title: string; content: string; viewMode: string };
      content = mdData.content;
      label = mdData.title || "Markdown";
    } else if (sourceNode.type === "file-viewer") {
      const fvData = sourceNode.data as { filePath: string; loadedContent?: string };
      content = fvData.loadedContent ?? "";
      label = fvData.filePath || "File";
    } else if (sourceNode.type === "note") {
      const noteData = sourceNode.data as { text: string; color: string };
      content = noteData.text;
      label = "Note";
    }

    if (!content.trim()) return null;
    return { nodeId: sourceNode.id, nodeType: sourceNode.type, label, content };
  }, []);

  /** Gather context items for nodes spatially inside a context-group. */
  const getContextFromGroup = useCallback((groupNode: CanvasNode): ContextItem[] => {
    const items: ContextItem[] = [];
    const contextNodeTypes = new Set(["markdown", "note", "file-viewer"]);
    for (const n of nodes) {
      if (n.id === groupNode.id) continue;
      if (!contextNodeTypes.has(n.type)) continue;
      if (!isInsideGroup(n, groupNode)) continue;
      const item = extractContextItem(n);
      if (item) items.push(item);
    }
    return items;
  }, [nodes, isInsideGroup, extractContextItem]);

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

      const item = extractContextItem(sourceNode);
      if (item) items.push(item);
    }
    return items;
  }, [nodes, graph, extractContextItem, getContextFromGroup]);

  // Keep a ref to the latest getContextForNode so stable closures can access it
  const getContextForNodeRef = useRef(getContextForNode);
  getContextForNodeRef.current = getContextForNode;

  // Stable per-node context getters: closures are created once per node ID and
  // reused across renders. The ref indirection ensures they always call the
  // latest getContextForNode without needing a new function identity.
  const contextGetterCacheRef = useRef(new Map<string, () => ContextItem[]>());
  const getStableContextGetter = useCallback((nodeId: string): (() => ContextItem[]) => {
    let getter = contextGetterCacheRef.current.get(nodeId);
    if (!getter) {
      getter = () => getContextForNodeRef.current(nodeId);
      contextGetterCacheRef.current.set(nodeId, getter);
    }
    return getter;
  }, []);

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

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleCanvasMouseDown}
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
      <DotGrid transform={transform} />

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
        onAttachSession={handleAttachSession}
        attachedSessionKeys={attachedSessionKeys}
      />

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
        {nodes.map((node) => (
          <CanvasNodeComponent
            key={node.id}
            node={node}
            transform={transform}
            isSelected={selectedIds.has(node.id)}
            onSelect={handleSelectNode}
            onMove={handleMoveNode}
            onUpdateData={handleUpdateNodeData}
            onResize={handleResizeNode}
            onAddContentNode={addContentNode}
            onRevealMinion={revealMinion}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            getContextForNode={getStableContextGetter(node.id)}
            projectPath={projectPath}
            onConnectionStart={handleConnectionStart}
            onConnectionEnd={handleConnectionEnd}
            isDragActive={connectionDrag !== null}
            validTargetPorts={validTargets}
            connectedPorts={connectedPorts}
            snapTargetKey={
              connectionDrag?.snapTarget
                ? `${connectionDrag.snapTarget.nodeId}:${connectionDrag.snapTarget.portId}`
                : undefined
            }
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            isDropTarget={dropTargetGroupId === node.id}
            draggingNodeId={draggingNodeId}
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

      <EdgeRenderer graph={graph} nodes={nodes} transform={transform} />

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

              // Compute source port position using visible-port spacing
              const dir = connectionDrag.source.direction;
              const visiblePorts = contract.ports.filter(
                (p) => p.direction === dir && !p.hidden,
              );
              const portIndex = visiblePorts.findIndex(
                (p) => p.id === connectionDrag.source.portId,
              );
              const spacing =
                srcNode.size.height / (visiblePorts.length + 1);
              const srcY =
                srcNode.position.y + spacing * (portIndex + 1);
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

      {/* Connection indicator */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 16,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          zIndex: 100,
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
            background: "rgba(15, 15, 25, 0.92)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(192, 132, 252, 0.3)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(192, 132, 252, 0.08)",
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
                // Delete only the group node(s) + other selected non-group nodes
                for (const id of [...pendingGroupDelete.groupIds, ...pendingGroupDelete.otherIds]) {
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
                // Delete groups + contained + other selected nodes
                const all = [
                  ...pendingGroupDelete.groupIds,
                  ...pendingGroupDelete.containedIds,
                  ...pendingGroupDelete.otherIds,
                ];
                for (const id of all) {
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

      <Toolbar
        transform={transform}
        onZoomIn={() => zoomTo(transform.scale * 1.25)}
        onZoomOut={() => zoomTo(transform.scale * 0.8)}
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
    </div>
  );
}
