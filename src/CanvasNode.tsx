import { useCallback, useRef, memo, useState } from "react";
import type { CanvasNode, Position, Size } from "./types.ts";
import { getNodeType } from "./node-registry.ts";
import { getContract, isPortOpen } from "./graph.ts";
import type { PortDefinition } from "./graph.ts";
import { PortDot } from "./components/PortDot.tsx";
import type { PortInfo } from "./components/PortDot.tsx";
import { wheelDetector } from "./wheel-detector.ts";
import { useCanvasNodeDrag } from "./use-canvas-node-drag.ts";
import { LeaderDragCard } from "./LeaderDragCard.tsx";
import type { SocketSubscribe } from "./use-socket.ts";

interface CanvasNodeProps {
  node: CanvasNode;
  isSelected: boolean;
  parked?: boolean | undefined;
  zoneConnections?: string | undefined;
  dragZoneName?: string | undefined;
  dragNodeCount?: number | undefined;
  /** Hide the live renderer while its moving group is represented by a preview. */
  isDragPreview?: boolean | undefined;
  onMoveToZone?: ((nodeId: string) => void) | undefined;
  onSelect: (id: string, additive: boolean) => void;
  onMove: (id: string, position: Position, cancelled?: boolean) => void;
  onUpdateData: (id: string, data: unknown) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
  getContextForNode?: (() => import("./types.ts").ContextItem[]) | undefined;
  getIncomingContextModes?: (() => string[]) | undefined;
  projectPath?: string | undefined;
  projectId?: string | undefined;
  projectSettings?: import("./api.ts").ProjectSettings | undefined;
  onResize?: ((id: string, size: Size) => void) | undefined;
  /** Callback to add text content as a new markdown node */
  onAddContentNode?: ((content: string) => void) | undefined;
  /** Callback to reveal (create or scroll-to) a minion node for a given session key */
  onRevealMinion?: ((minionSessionKey: string) => void) | undefined;
  /** Callback for LeaderNode: duplicate setup without runtime session state */
  onDuplicateLeaderSetup?: ((nodeId: string) => void) | undefined;
  /** Callback for LeaderNode: open a System Model node for this session */
  onOpenSystemModel?: ((nodeId: string) => void) | undefined;
  /** Callback for LeaderNode: save setup as a reusable preset */
  onSaveLeaderPreset?: ((nodeId: string, input: {
    name: string;
    description?: string;
    systemPromptPrefix?: string;
  }) => boolean) | undefined;
  /** Callback to center/focus this node in the canvas viewport */
  onFocusNode?: ((nodeId: string) => void) | undefined;
  /** Connection drag callbacks — threaded from Canvas */
  onConnectionStart?: ((port: PortInfo, e: React.MouseEvent) => void) | undefined;
  onConnectionEnd?: ((port: PortInfo) => void) | undefined;
  /** Whether a connection drag is currently in progress */
  isDragActive?: boolean | undefined;
  /** Port IDs that are valid drop targets for the current drag */
  validTargetPorts?: Set<string> | undefined;
  /** "nodeId:portId" of the port currently being snapped to, if any */
  snapTargetKey?: string | undefined;
  /** Set of "nodeId:portId" keys for all ports that have at least one edge */
  connectedPorts?: Set<string> | undefined;
  /** Called when the user starts dragging this node */
  onDragStart?: ((nodeId: string, event?: MouseEvent) => void) | undefined;
  /** Called when the user stops dragging this node */
  onDragEnd?: ((nodeId: string, event?: MouseEvent) => void) | undefined;
  /** True when a droppable node is hovering over this node (context-group) */
  isDropTarget?: boolean | undefined;
  /** True when this node is currently being dragged by the user.
   *  Pre-computed from draggingNodeId === node.id in Canvas so we pass a
   *  stable boolean instead of the raw string ID (which would bust memo
   *  on ALL nodes whenever any drag starts/ends). */
  isBeingDragged?: boolean | undefined;
  /** True when this node is inside a context-group that is currently being dragged */
  isInsideDraggingGroup?: boolean | undefined;
  /** True when this node is spatially inside any context-group */
  isInsideContextGroup?: boolean | undefined;
}

/**
 * Check whether a port is currently locked via its lifecycle callback.
 * Used for visual lock indicators and dynamic port hiding.
 */
function isPortLocked(node: CanvasNode, portId: string): boolean {
  return !isPortOpen(node.type, portId, node.data);
}

/** Context values that drive dynamic port visibility decisions. */
export interface PortVisibilityContext {
  node: CanvasNode;
  connectedPorts: Set<string> | undefined;
  /** Set of "nodeId:portId" keys that are valid targets for the current drag. */
  validTargetPorts: Set<string> | undefined;
  isInsideContextGroup: boolean;
}

/**
 * Returns true when `port` should not be rendered on the canvas.
 *
 * Rules:
 * - Leader input ports: hidden when locked (session active) and unconnected.
 * - Leader task-out port: hidden when no minion is connected, unless a
 *   connection drag is currently targeting this port (so the user can still
 *   drop onto it from a minion's task-in).
 * - File-viewer / markdown output ports: hidden when the node sits inside a
 *   context-group and has no edge (the group's port handles the connection).
 *
 * Exported for unit testing.
 */
export function isPortDynamicallyHidden(
  port: PortDefinition,
  ctx: PortVisibilityContext,
): boolean {
  const { node, connectedPorts, validTargetPorts, isInsideContextGroup } = ctx;
  const portKey = `${node.id}:${port.id}`;
  const isConnected = connectedPorts?.has(portKey) ?? false;

  // Leader: hide locked input ports that have no edges
  if (node.type === "leader" && port.direction === "input") {
    if (isPortLocked(node, port.id) && !isConnected) return true;
  }

  // Leader: hide the task-out port when no minion is connected.
  // Exception: reveal it while a connection drag is targeting it so the user
  // can complete the connection (snap detection is mathematical, not DOM-based,
  // but the port must be rendered to show the visual drop indicator).
  if (node.type === "leader" && port.id === "task-out" && !isConnected) {
    const isValidDragTarget = validTargetPorts?.has(portKey) ?? false;
    if (!isValidDragTarget) return true;
  }

  // File-viewer & markdown: hide output ports when inside a context-group
  // and not connected (the group's own port handles the connection instead).
  // When outside a group, always show the port so the user can connect it.
  if (
    (node.type === "file-viewer" || node.type === "markdown") &&
    port.direction === "output" &&
    isInsideContextGroup &&
    !isConnected
  ) {
    return true;
  }

  return false;
}

export const CanvasNodeComponent = memo(function CanvasNodeComponent({
  node,
  isSelected,
  parked = false,
  zoneConnections,
  dragZoneName,
  dragNodeCount,
  isDragPreview = false,
  onMoveToZone,
  onSelect,
  onMove,
  onUpdateData,
  socketSend,
  socketSubscribe,
  getContextForNode,
  getIncomingContextModes,
  projectPath,
  projectId,
  projectSettings,
  onResize,
  onAddContentNode,
  onRevealMinion,
  onDuplicateLeaderSetup,
  onOpenSystemModel,
  onSaveLeaderPreset,
  onFocusNode,
  onConnectionStart,
  onConnectionEnd,
  isDragActive = false,
  validTargetPorts,
  snapTargetKey,
  onDragStart,
  onDragEnd,
  isDropTarget = false,
  isBeingDragged = false,
  isInsideDraggingGroup = false,
  isInsideContextGroup = false,
  connectedPorts,
}: CanvasNodeProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const { pointer: dragPointer, onMouseDown: handleMouseDown } = useCanvasNodeDrag({
    node, isSelected, onSelect, onMove, onDragStart, onDragEnd,
  });
  const hiddenForDrag = isDragPreview || (!!dragPointer && node.type === "leader");

  /** Absorb mouse-wheel zoom events on nodes so the canvas never zooms
   *  while the pointer is over a node. Trackpad pan events are allowed
   *  to bubble up so two-finger panning works seamlessly over nodes.
   *  Scrollable children inside [data-scroll-capture] zones still scroll
   *  normally — the canvas wheel handler checks for those. */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const native = e.nativeEvent;
    const isPinch = native.ctrlKey || native.metaKey;
    const device = wheelDetector.classify(native);

    if (isPinch || device === "mouse") {
      // Zoom-type event — absorb so the canvas doesn't zoom over nodes
      e.stopPropagation();
    }
    // Trackpad pan events bubble up to the canvas for seamless panning
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (node.type !== "leader" || !onFocusNode) return;

      const target = e.target as Element;
      const interactiveTags = new Set(["input", "textarea", "select", "button", "a", "label"]);
      if (
        interactiveTags.has(target.tagName.toLowerCase()) ||
        target.closest("[contenteditable]") ||
        target.closest("[data-no-drag]") ||
        target.closest("[data-scroll-capture]")
      ) {
        return;
      }

      e.stopPropagation();
      onFocusNode(node.id);
    },
    [node.id, node.type, onFocusNode],
  );

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
  const handleDuplicateLeaderSetup = useCallback(
    () => onDuplicateLeaderSetup?.(node.id),
    [node.id, onDuplicateLeaderSetup],
  );
  const handleOpenSystemModel = useCallback(
    () => onOpenSystemModel?.(node.id),
    [node.id, onOpenSystemModel],
  );
  const handleSaveLeaderPreset = useCallback(
    (input: {
      name: string;
      description?: string;
      systemPromptPrefix?: string;
    }) => onSaveLeaderPreset?.(node.id, input) ?? false,
    [node.id, onSaveLeaderPreset],
  );
  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);
  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  const typeDef = getNodeType(node.type);
  if (!typeDef) return null;

  const NodeRenderer = typeDef.render;

  // ── Port dots from contract ──────────────────────────
  const contract = getContract(node.type);
  const portDots: React.ReactNode[] = [];

  const portVisibilityCtx: PortVisibilityContext = {
    node,
    connectedPorts,
    validTargetPorts,
    isInsideContextGroup,
  };

  if (contract) {
    const inputPorts = contract.ports.filter(
      (p) => p.direction === "input" && !isPortDynamicallyHidden(p, portVisibilityCtx),
    );
    const outputPorts = contract.ports.filter(
      (p) => p.direction === "output" && !isPortDynamicallyHidden(p, portVisibilityCtx),
    );

    // Same spacing math as EdgeRenderer.getPortPosition
    const height = node.size.height;

    for (const [i, port] of inputPorts.entries()) {
      const topPx = port.anchorY != null
        ? height * port.anchorY
        : height / (inputPorts.length + 1) * (i + 1);
      const portKey = `${node.id}:${port.id}`;
      portDots.push(
        <PortDot
          key={`in-${port.id}`}
          direction="input"
          protocol={port.protocol}
          label={port.label}
          topPx={topPx}
          locked={isPortLocked(node, port.id)}
          nodeId={node.id}
          portId={port.id}
          nodeType={node.type}
          onConnectionStart={onConnectionStart}
          onConnectionEnd={onConnectionEnd}
          isDragActive={isDragActive}
          isValidTarget={validTargetPorts?.has(portKey) ?? false}
          isSnapTarget={snapTargetKey === portKey}
        />,
      );
    }

    for (const [i, port] of outputPorts.entries()) {
      const topPx = port.anchorY != null
        ? height * port.anchorY
        : height / (outputPorts.length + 1) * (i + 1);
      const portKey = `${node.id}:${port.id}`;
      portDots.push(
        <PortDot
          key={`out-${port.id}`}
          direction="output"
          protocol={port.protocol}
          label={port.label}
          topPx={topPx}
          locked={isPortLocked(node, port.id)}
          nodeId={node.id}
          portId={port.id}
          nodeType={node.type}
          onConnectionStart={onConnectionStart}
          onConnectionEnd={onConnectionEnd}
          isDragActive={isDragActive}
          isValidTarget={validTargetPorts?.has(portKey) ?? false}
          isSnapTarget={snapTargetKey === portKey}
        />,
      );
    }
  }

  return (
    <>
    {dragPointer && hiddenForDrag && <LeaderDragCard node={node} pointer={dragPointer} zoneName={dragZoneName} count={dragNodeCount} />}
    <div
      ref={nodeRef}
      className="canvas-node-card"
      data-canvas-node-id={node.id}
      data-parked={parked || undefined}
      inert={hiddenForDrag ? true : undefined}
      onContextMenu={onMoveToZone ? event => {
        if (!event.currentTarget.contains(event.target as Node) || (event.target as Element).closest("input,textarea,[contenteditable=true]")) return;
        event.preventDefault(); event.stopPropagation(); onMoveToZone(node.id);
      } : undefined}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      style={{
        display: parked ? "none" : undefined,
        // Keep the live renderer and its geometry mounted while the drag card takes over.
        visibility: hiddenForDrag ? "hidden" : undefined,
        opacity: hiddenForDrag ? 0 : undefined,
        pointerEvents: hiddenForDrag ? "none" : undefined,
        position: "absolute",
        // Use translate3d instead of left/top — this promotes the node to its
        // own compositor layer so position changes during drag skip layout
        // recalculation entirely and run on the GPU.
        left: 0,
        top: 0,
        transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)`,
        willChange: isBeingDragged ? "transform" : "auto",
        width: node.size.width,
        ...(typeDef.autoHeight
          ? { minHeight: node.size.height, height: "auto" }
          : { height: node.size.height }),
        cursor: isBeingDragged ? "grabbing" : "grab",
        outline: isSelected
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        outlineOffset: 2,
        borderRadius: "var(--radius-node)",
        // Smooth transitions for position when not being actively dragged
        // (e.g. after drop when context-group restacks nodes).
        // Width/height transition outside manual resize so host-triggered
        // growth (for example the embedded leader dashboard) has motion while
        // drag resizing remains direct.
        transition: isBeingDragged || isInsideDraggingGroup
          ? "outline-color 0.15s, filter 0.2s"
          : [
            "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
            ...(isResizing
              ? []
              : [
                "width 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
                "height 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
              ]),
            "outline-color 0.15s",
            "filter 0.2s",
          ].join(", "),
        zIndex: isBeingDragged
          ? 50
          : isInsideDraggingGroup
            ? 51
            : node.type === "context-group"
              ? 0                           // context groups always stay below children
              : isSelected ? 10 : 1,
        // Brief scale-in on mount so newly added nodes catch the eye
        animation: hiddenForDrag ? "none" : "nodeEnter 0.25s cubic-bezier(0.22, 1, 0.36, 1) both",
        // Lift effect when dragging over a group
        ...(isBeingDragged && {
          filter: "drop-shadow(0 12px 24px var(--overlay-bg))",
        }),
      }}
    >
      {/* Port dots — rendered outside the inner node renderer so they
          are never clipped by overflow:hidden containers */}
      {zoneConnections && <div className="canvas-zone-connection-label" style={{ position: "absolute", top: -24, left: 0,
        fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-secondary)", padding: "3px 6px", borderRadius: 5 }}>{zoneConnections}</div>}
      {portDots}

      <NodeRenderer
        node={node}
        isSelected={isSelected}
        onUpdateData={handleNodeUpdate}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
        getContextForNode={getContextForNode}
        getIncomingContextModes={getIncomingContextModes}
        projectPath={projectPath}
        projectId={projectId}
        projectSettings={projectSettings}
        onResize={handleResize}
        onResizeStart={handleResizeStart}
        onResizeEnd={handleResizeEnd}
        onAddContentNode={onAddContentNode}
        onRevealMinion={onRevealMinion}
        onDuplicateLeaderSetup={
          onDuplicateLeaderSetup ? handleDuplicateLeaderSetup : undefined
        }
        onOpenSystemModel={onOpenSystemModel ? handleOpenSystemModel : undefined}
        onSaveLeaderPreset={onSaveLeaderPreset ? handleSaveLeaderPreset : undefined}
        isDropTarget={isDropTarget}
        isBeingDragged={isBeingDragged}
      />
    </div>
    </>
  );
});
