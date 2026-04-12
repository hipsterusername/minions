import { useCallback, useRef, memo } from "react";
import type { CanvasNode, CanvasTransform, Position, Size } from "./types.ts";
import { getNodeType } from "./node-registry.ts";
import { getContract } from "./graph.ts";
import { PortDot } from "./components/PortDot.tsx";
import type { PortInfo } from "./components/PortDot.tsx";

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
  /** Callback to add text content as a new markdown node */
  onAddContentNode?: (content: string) => void;
  /** Callback to reveal (create or scroll-to) a minion node for a given session key */
  onRevealMinion?: (minionSessionKey: string) => void;
  /** Connection drag callbacks — threaded from Canvas */
  onConnectionStart?: (port: PortInfo, e: React.MouseEvent) => void;
  onConnectionEnd?: (port: PortInfo) => void;
  /** Whether a connection drag is currently in progress */
  isDragActive?: boolean;
  /** Port IDs that are valid drop targets for the current drag */
  validTargetPorts?: Set<string>;
  /** "nodeId:portId" of the port currently being snapped to, if any */
  snapTargetKey?: string;
  /** Set of "nodeId:portId" keys for all ports that have at least one edge */
  connectedPorts?: Set<string>;
  /** Called when the user starts dragging this node */
  onDragStart?: (nodeId: string) => void;
  /** Called when the user stops dragging this node */
  onDragEnd?: (nodeId: string) => void;
  /** True when a droppable node is hovering over this node (context-group) */
  isDropTarget?: boolean;
  /** ID of the node currently being dragged (null when idle) */
  draggingNodeId?: string | null;
  /** True when this node is inside a context-group that is currently being dragged */
  isInsideDraggingGroup?: boolean;
  /** True when this node is spatially inside any context-group */
  isInsideContextGroup?: boolean;
}

/**
 * Compute the port label for context-in on leader nodes. Returns the locked
 * state based on whether the session has already started.
 */
function isPortLocked(node: CanvasNode, portId: string): boolean {
  if (node.type === "leader" && portId === "context-in") {
    const data = node.data as { sessionKey?: string | null } | undefined;
    return !!data?.sessionKey;
  }
  return false;
}

export const CanvasNodeComponent = memo(function CanvasNodeComponent({
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
  onAddContentNode,
  onRevealMinion,
  onConnectionStart,
  onConnectionEnd,
  isDragActive = false,
  validTargetPorts,
  snapTargetKey,
  onDragStart,
  onDragEnd,
  isDropTarget = false,
  draggingNodeId,
  isInsideDraggingGroup = false,
  isInsideContextGroup = false,
  connectedPorts,
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

      // Don't steal drag from interactive elements — let them handle their own
      // mouse events so text inside inputs/textareas remains selectable.
      const target = e.target as Element;
      const interactiveTags = new Set(["input", "textarea", "select", "button", "a", "label"]);
      if (
        interactiveTags.has(target.tagName.toLowerCase()) ||
        target.closest("[contenteditable]") ||
        target.closest("[data-no-drag]")
      ) {
        return;
      }

      e.stopPropagation();
      // Prevent the browser from starting a text-selection drag from this
      // mousedown. Interactive children are excluded above, so this only
      // fires when we're actually initiating a node-move gesture.
      e.preventDefault();

      // e.preventDefault() above suppresses the browser's natural focus-shift,
      // meaning any previously-focused child (textarea, input, etc.) stays as
      // document.activeElement. That would swallow canvas hotkeys like Delete.
      // Explicitly blur it so keyboard events route to the window level.
      if (
        document.activeElement &&
        document.activeElement !== document.body &&
        document.activeElement !== document.documentElement
      ) {
        (document.activeElement as HTMLElement).blur();
      }

      // ── Multi-select drag UX ──
      // When clicking a node that's already part of a multi-selection WITHOUT
      // shift, defer the "narrow to single" selection until mouseup — so the
      // user can start dragging the whole group without losing the selection.
      const isPartOfMultiSelect = isSelected && !e.shiftKey;
      if (!isPartOfMultiSelect) {
        onSelect(node.id, e.shiftKey);
      }

      // Disable text selection for the whole document while dragging so that
      // fast mouse moves don't accidentally highlight content under the cursor.
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        nodeStartX: node.position.x,
        nodeStartY: node.position.y,
      };

      let didDrag = false;
      onDragStart?.(node.id);

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = (ev.clientX - dragRef.current.startX) / transform.scale;
        const dy = (ev.clientY - dragRef.current.startY) / transform.scale;
        // Only count as a drag if we've moved at least 3px (avoids jitter
        // on click from accidentally narrowing multi-select)
        if (!didDrag && Math.abs(dx) + Math.abs(dy) > 3 / transform.scale) {
          didDrag = true;
        }
        onMove(node.id, {
          x: dragRef.current.nodeStartX + dx,
          y: dragRef.current.nodeStartY + dy,
        });
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        onDragEnd?.(node.id);

        // If the node was part of a multi-select and the user clicked
        // without dragging, narrow to single selection now.
        if (isPartOfMultiSelect && !didDrag) {
          onSelect(node.id, false);
        }

        // Restore whatever user-select was set before the drag started.
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [node.id, node.position, transform.scale, isSelected, onSelect, onMove, onDragStart, onDragEnd],
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

  const isBeingDragged = draggingNodeId === node.id;

  // ── Port dots from contract ──────────────────────────
  const contract = getContract(node.type);
  const portDots: React.ReactNode[] = [];

  // Decide whether a port should be visually hidden beyond the static `hidden` flag.
  // - Leader input ports: hide when disabled (locked) and not connected
  // - File-viewer / markdown output ports: hide when not connected
  const isPortDynamicallyHidden = (port: import("./graph.ts").PortDefinition): boolean => {
    const portKey = `${node.id}:${port.id}`;
    const isConnected = connectedPorts?.has(portKey) ?? false;

    // Leader: hide disabled (locked) input ports that have no edges
    if (node.type === "leader" && port.direction === "input") {
      if (isPortLocked(node, port.id) && !isConnected) return true;
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
  };

  if (contract) {
    const inputPorts = contract.ports.filter((p) => p.direction === "input" && !p.hidden && !isPortDynamicallyHidden(p));
    const outputPorts = contract.ports.filter((p) => p.direction === "output" && !p.hidden && !isPortDynamicallyHidden(p));

    // Same spacing math as EdgeRenderer.getPortPosition
    const height = node.size.height;

    for (let i = 0; i < inputPorts.length; i++) {
      const port = inputPorts[i];
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

    for (let i = 0; i < outputPorts.length; i++) {
      const port = outputPorts[i];
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
        cursor: isBeingDragged ? "grabbing" : "grab",
        outline: isSelected
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        outlineOffset: 2,
        borderRadius: 10,
        // Smooth transitions for position when not being actively dragged
        // (e.g. after drop when context-group restacks nodes).
        // Width/height are NOT transitioned — they must update instantly
        // for resize handles and context-group auto-fit to feel responsive.
        transition: isBeingDragged || isInsideDraggingGroup
          ? "outline-color 0.15s, filter 0.2s"
          : [
            "left 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
            "top 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
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
        animation: "nodeEnter 0.25s cubic-bezier(0.22, 1, 0.36, 1) both",
        // Lift effect when dragging over a group
        ...(isBeingDragged && {
          filter: "drop-shadow(0 12px 24px var(--overlay-bg))",
        }),
      }}
    >
      {/* Port dots — rendered outside the inner node renderer so they
          are never clipped by overflow:hidden containers */}
      {portDots}

      <NodeRenderer
        node={node}
        isSelected={isSelected}
        onUpdateData={handleNodeUpdate}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
        getContextForNode={getContextForNode}
        projectPath={projectPath}
        onResize={handleResize}
        onAddContentNode={onAddContentNode}
        onRevealMinion={onRevealMinion}
        canvasScale={transform.scale}
        isDropTarget={isDropTarget}
        isBeingDragged={isBeingDragged}
      />
    </div>
  );
});
