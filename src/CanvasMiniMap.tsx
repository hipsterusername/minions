import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
  type WheelEvent,
} from "react";
import {
  DockPanel,
  DockPanelHeader,
  useDockBadge,
  useDockPanelOpen,
} from "./BottomRightDock.tsx";
import type { GraphEdge } from "./graph.ts";
import type { CanvasNode, CanvasTransform } from "./types.ts";

const MINI_MAP_WIDTH = 272;
const MINI_MAP_VIEW_W = 248;
const MINI_MAP_VIEW_H = 148;
const MINI_MAP_WORLD_PAD = 160;

export interface MiniMapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MiniMapLayout {
  bounds: MiniMapRect;
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface CanvasMiniMapProps {
  nodes: CanvasNode[];
  edges: GraphEdge[];
  transform: CanvasTransform;
  setTransform: Dispatch<SetStateAction<CanvasTransform>>;
  containerRef: RefObject<HTMLDivElement | null>;
  selectedIds: Set<string>;
  activeNodeIds: Set<string>;
  onFitView: () => void;
  onFocusSelected: () => void;
  hasSelection: boolean;
  onZoomTo: (scale: number) => void;
}

function clampDimension(value: number): number {
  return Math.max(1, value);
}

export function viewportWorldRect(
  transform: CanvasTransform,
  viewport: { width: number; height: number },
): MiniMapRect {
  return {
    x: -transform.x / transform.scale,
    y: -transform.y / transform.scale,
    width: viewport.width / transform.scale,
    height: viewport.height / transform.scale,
  };
}

export function miniMapWorldBounds(
  nodes: CanvasNode[],
  viewport: MiniMapRect | null,
): MiniMapRect {
  if (nodes.length === 0) {
    const fallback = viewport ?? { x: -400, y: -300, width: 800, height: 600 };
    return {
      x: fallback.x - MINI_MAP_WORLD_PAD,
      y: fallback.y - MINI_MAP_WORLD_PAD,
      width: fallback.width + MINI_MAP_WORLD_PAD * 2,
      height: fallback.height + MINI_MAP_WORLD_PAD * 2,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.size.width);
    maxY = Math.max(maxY, node.position.y + node.size.height);
  }

  if (viewport) {
    minX = Math.min(minX, viewport.x);
    minY = Math.min(minY, viewport.y);
    maxX = Math.max(maxX, viewport.x + viewport.width);
    maxY = Math.max(maxY, viewport.y + viewport.height);
  }

  return {
    x: minX - MINI_MAP_WORLD_PAD,
    y: minY - MINI_MAP_WORLD_PAD,
    width: clampDimension(maxX - minX + MINI_MAP_WORLD_PAD * 2),
    height: clampDimension(maxY - minY + MINI_MAP_WORLD_PAD * 2),
  };
}

export function createMiniMapLayout(
  bounds: MiniMapRect,
  width: number,
  height: number,
): MiniMapLayout {
  const scale = Math.min(width / bounds.width, height / bounds.height);
  const contentW = bounds.width * scale;
  const contentH = bounds.height * scale;
  return {
    bounds,
    width,
    height,
    scale,
    offsetX: (width - contentW) / 2,
    offsetY: (height - contentH) / 2,
  };
}

export function worldToMiniMapRect(
  rect: MiniMapRect,
  layout: MiniMapLayout,
): MiniMapRect {
  return {
    x: layout.offsetX + (rect.x - layout.bounds.x) * layout.scale,
    y: layout.offsetY + (rect.y - layout.bounds.y) * layout.scale,
    width: rect.width * layout.scale,
    height: rect.height * layout.scale,
  };
}

export function miniMapPointToWorld(
  point: { x: number; y: number },
  layout: MiniMapLayout,
): { x: number; y: number } {
  return {
    x: layout.bounds.x + (point.x - layout.offsetX) / layout.scale,
    y: layout.bounds.y + (point.y - layout.offsetY) / layout.scale,
  };
}

function nodeCenter(node: CanvasNode): { x: number; y: number } {
  return {
    x: node.position.x + node.size.width / 2,
    y: node.position.y + node.size.height / 2,
  };
}

function nodeTint(node: CanvasNode, active: boolean): string {
  if (active) return "var(--status-running)";
  switch (node.type) {
    case "leader":
      return "var(--accent)";
    case "minion":
      return "var(--edge-task)";
    case "markdown":
    case "note":
      return "var(--status-success)";
    case "file-viewer":
      return "var(--status-warning)";
    case "image":
      return "var(--status-error)";
    case "context-group":
      return "var(--text-muted)";
    default:
      return "var(--text-secondary)";
  }
}

export const CanvasMiniMap = memo(function CanvasMiniMap({
  nodes,
  edges,
  transform,
  setTransform,
  containerRef,
  selectedIds,
  activeNodeIds,
  onFitView,
  onFocusSelected,
  hasSelection,
  onZoomTo,
}: CanvasMiniMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const isOpen = useDockPanelOpen("map");

  useDockBadge("map", {
    count: nodes.length > 0 ? nodes.length : undefined,
    tail: `${Math.round(transform.scale * 100)}%`,
  });

  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      setViewportSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [containerRef, isOpen]);

  const viewportRect = useMemo(() => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return null;
    return viewportWorldRect(transform, viewportSize);
  }, [transform, viewportSize]);

  const bounds = useMemo(
    () => miniMapWorldBounds(nodes, viewportRect),
    [nodes, viewportRect],
  );

  const layout = useMemo(
    () => createMiniMapLayout(bounds, MINI_MAP_VIEW_W, MINI_MAP_VIEW_H),
    [bounds],
  );

  const viewportMiniRect = useMemo(
    () => viewportRect ? worldToMiniMapRect(viewportRect, layout) : null,
    [viewportRect, layout],
  );

  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const centerViewport = useCallback(
    (worldCenter: { x: number; y: number }) => {
      const container = containerRef.current;
      if (!container) return;
      setTransform((prev) => ({
        ...prev,
        x: container.clientWidth / 2 - worldCenter.x * prev.scale,
        y: container.clientHeight / 2 - worldCenter.y * prev.scale,
      }));
    },
    [containerRef, setTransform],
  );

  const miniPointFromEvent = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * MINI_MAP_VIEW_W,
      y: ((event.clientY - rect.top) / rect.height) * MINI_MAP_VIEW_H,
    };
  }, []);

  const moveViewportToEvent = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const point = miniPointFromEvent(event);
      if (!point) return;
      const world = miniMapPointToWorld(point, layout);
      centerViewport({
        x: world.x - dragOffsetRef.current.x,
        y: world.y - dragOffsetRef.current.y,
      });
    },
    [centerViewport, layout, miniPointFromEvent],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const point = miniPointFromEvent(event);
      if (!point) return;
      const world = miniMapPointToWorld(point, layout);
      const target = event.target as Element | null;
      const startedOnViewport = !!target?.closest?.("[data-minimap-viewport]");

      if (startedOnViewport && viewportRect) {
        dragOffsetRef.current = {
          x: world.x - (viewportRect.x + viewportRect.width / 2),
          y: world.y - (viewportRect.y + viewportRect.height / 2),
        };
      } else {
        dragOffsetRef.current = { x: 0, y: 0 };
        centerViewport(world);
      }

      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [centerViewport, layout, miniPointFromEvent, viewportRect],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (!dragging) return;
      event.preventDefault();
      event.stopPropagation();
      moveViewportToEvent(event);
    },
    [dragging, moveViewportToEvent],
  );

  const handlePointerUp = useCallback((event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    dragOffsetRef.current = { x: 0, y: 0 };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<SVGRectElement>) => {
      if (!viewportRect) return;
      const coarseStep = event.shiftKey ? 0.42 : 0.16;
      const xStep = viewportRect.width * coarseStep;
      const yStep = viewportRect.height * coarseStep;
      let dx = 0;
      let dy = 0;

      switch (event.key) {
        case "ArrowLeft":
          dx = -xStep;
          break;
        case "ArrowRight":
          dx = xStep;
          break;
        case "ArrowUp":
          dy = -yStep;
          break;
        case "ArrowDown":
          dy = yStep;
          break;
        case "Home":
          event.preventDefault();
          onFitView();
          return;
        case "+":
        case "=":
          event.preventDefault();
          onZoomTo(transform.scale * 1.1);
          return;
        case "-":
        case "_":
          event.preventDefault();
          onZoomTo(transform.scale / 1.1);
          return;
        default:
          return;
      }

      event.preventDefault();
      setTransform((prev) => ({
        ...prev,
        x: prev.x - dx * prev.scale,
        y: prev.y - dy * prev.scale,
      }));
    },
    [onFitView, onZoomTo, setTransform, transform.scale, viewportRect],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY > 0 ? 1 / 1.08 : 1.08;
      onZoomTo(transform.scale * factor);
    },
    [onZoomTo, transform.scale],
  );

  const buttonStyle = {
    width: 24,
    height: 24,
    borderRadius: 6,
    border: "1px solid var(--border-default)",
    background: "var(--bg-surface)",
    color: "var(--text-secondary)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    lineHeight: 1,
  } satisfies CSSProperties;

  return (
    <DockPanel id="map" width={MINI_MAP_WIDTH}>
      <DockPanelHeader
        icon={<MiniMapIcon />}
        title={
          <span title={`${nodes.length} nodes on canvas`}>
            Map · {nodes.length} nodes · {Math.round(transform.scale * 100)}%
          </span>
        }
        actions={
          <>
            <button
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => onZoomTo(transform.scale / 1.1)}
              style={buttonStyle}
            >
              -
            </button>
            <button
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => onZoomTo(transform.scale * 1.1)}
              style={buttonStyle}
            >
              +
            </button>
            <button
              aria-label="Fit canvas"
              title="Fit canvas"
              onClick={onFitView}
              style={buttonStyle}
            >
              <FitIcon />
            </button>
          </>
        }
      />
      <div data-minimap="" onWheel={handleWheel}>
        <div
          style={{
            position: "relative",
            padding: "10px 12px 8px",
          }}
        >
          <svg
            ref={svgRef}
            role="application"
            aria-label="Canvas mini-map"
            viewBox={`0 0 ${MINI_MAP_VIEW_W} ${MINI_MAP_VIEW_H}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{
              width: MINI_MAP_VIEW_W,
              height: MINI_MAP_VIEW_H,
              display: "block",
              borderRadius: 7,
              background: "var(--bg-primary)",
              border: "1px solid var(--border-default)",
              cursor: dragging ? "grabbing" : "crosshair",
              touchAction: "none",
            }}
          >
            <defs>
              <pattern id="minimap-grid" width="12" height="12" patternUnits="userSpaceOnUse">
                <path
                  d="M 12 0 L 0 0 0 12"
                  fill="none"
                  stroke="var(--dot-grid)"
                  strokeWidth="0.75"
                  opacity="0.7"
                />
              </pattern>
            </defs>
            <rect width={MINI_MAP_VIEW_W} height={MINI_MAP_VIEW_H} fill="url(#minimap-grid)" />

            {edges.map((edge) => {
              const source = nodesById.get(edge.sourceNodeId);
              const target = nodesById.get(edge.targetNodeId);
              if (!source || !target) return null;
              const p1 = miniMapPointToSvg(nodeCenter(source), layout);
              const p2 = miniMapPointToSvg(nodeCenter(target), layout);
              return (
                <line
                  key={edge.id}
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  stroke={edge.protocol === "context" ? "var(--edge-context)" : "var(--edge-task)"}
                  strokeWidth="1"
                  strokeOpacity="0.26"
                />
              );
            })}

            {nodes.length === 0 && (
              <text
                x={MINI_MAP_VIEW_W / 2}
                y={MINI_MAP_VIEW_H / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--text-dim)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                Empty canvas
              </text>
            )}

            {nodes.map((node) => {
              const rect = worldToMiniMapRect(
                {
                  x: node.position.x,
                  y: node.position.y,
                  width: node.size.width,
                  height: node.size.height,
                },
                layout,
              );
              const selected = selectedIds.has(node.id);
              const active = activeNodeIds.has(node.id);
              const minW = node.type === "context-group" ? 6 : 4;
              const minH = node.type === "context-group" ? 6 : 4;
              return (
                <rect
                  key={node.id}
                  x={rect.x}
                  y={rect.y}
                  width={Math.max(minW, rect.width)}
                  height={Math.max(minH, rect.height)}
                  rx={node.type === "context-group" ? 2.5 : 1.5}
                  fill={node.type === "context-group" ? "transparent" : nodeTint(node, active)}
                  fillOpacity={active ? 0.9 : selected ? 0.82 : 0.52}
                  stroke={selected ? "var(--accent)" : nodeTint(node, active)}
                  strokeWidth={selected ? 2 : node.type === "context-group" ? 1.2 : 0.75}
                  strokeOpacity={active || selected ? 0.95 : 0.58}
                  strokeDasharray={node.type === "context-group" ? "3 2" : undefined}
                />
              );
            })}

            {viewportMiniRect && (
              <rect
                data-minimap-viewport=""
                tabIndex={0}
                aria-label="Mini-map viewport; drag or use arrow keys to pan canvas"
                aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home + -"
                x={viewportMiniRect.x}
                y={viewportMiniRect.y}
                width={Math.max(12, viewportMiniRect.width)}
                height={Math.max(12, viewportMiniRect.height)}
                rx={3}
                fill="rgba(255,255,255,0.04)"
                stroke="var(--accent)"
                strokeWidth="1.8"
                style={{
                  cursor: dragging ? "grabbing" : "grab",
                  outline: "none",
                }}
                onKeyDown={handleKeyDown}
              />
            )}
          </svg>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 8,
            }}
          >
            <button
              aria-label="Focus selected nodes"
              title="Focus selected nodes"
              onClick={hasSelection ? onFocusSelected : undefined}
              disabled={!hasSelection}
              style={{
                ...buttonStyle,
                width: 30,
                opacity: hasSelection ? 1 : 0.42,
                cursor: hasSelection ? "pointer" : "default",
              }}
            >
              <TargetIcon />
            </button>
            <span
              style={{
                color: "var(--text-muted)",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Drag the frame or click the map to navigate
            </span>
          </div>
        </div>
      </div>
    </DockPanel>
  );
});

function miniMapPointToSvg(
  point: { x: number; y: number },
  layout: MiniMapLayout,
): { x: number; y: number } {
  return {
    x: layout.offsetX + (point.x - layout.bounds.x) * layout.scale,
    y: layout.offsetY + (point.y - layout.bounds.y) * layout.scale,
  };
}

function MiniMapIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: "var(--text-secondary)", flexShrink: 0 }}
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <rect x="5" y="6" width="4" height="3" rx="0.8" />
      <path d="M10.5 5.5h1.5M10.5 8h1.5M4 11h8" />
    </svg>
  );
}

function FitIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 2H3a1 1 0 0 0-1 1v2.5M10.5 2H13a1 1 0 0 1 1 1v2.5M5.5 14H3a1 1 0 0 1-1-1v-2.5M10.5 14H13a1 1 0 0 0 1-1v-2.5" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </svg>
  );
}
