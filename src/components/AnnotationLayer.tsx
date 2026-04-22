/**
 * Annotation layer — an SVG overlay that owns pin and rectangle markup
 * in normalized (0–1) coordinates, so annotations survive container
 * resize / zoom. Reused by ImageNode today and by WebPreviewNode /
 * PdfPageNode later (Phase 4 of docs/visual-context-plan.md).
 *
 * Coordinates are always stored as ratios of the container's rendered
 * size. Pixel math happens on read/write at the event boundary.
 */
import {
  useRef,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type AnnotationTool = "select" | "pin" | "rect";

export interface PinAnnotation {
  id: string;
  kind: "pin";
  /** 0–1 normalized */
  x: number;
  y: number;
  note: string;
  color: string;
  order: number;
}

export interface RectAnnotation {
  id: string;
  kind: "rect";
  /** 0–1 normalized top-left */
  x: number;
  y: number;
  /** 0–1 normalized size */
  w: number;
  h: number;
  note: string;
  color: string;
  order: number;
}

export type Annotation = PinAnnotation | RectAnnotation;

export interface AnnotationLayerProps {
  annotations: ReadonlyArray<Annotation>;
  tool: AnnotationTool;
  defaultColor: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (annotation: Annotation) => void;
  onUpdate: (id: string, patch: Partial<Annotation>) => void;
  /** Draws annotations but disables edit interactions. */
  readOnly?: boolean;
}

/** Stable id using the time and a short random — fine for local-only IDs. */
function makeId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Clamp a normalized value to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Convert a pointer event to normalized coords within the given rect. */
function toNormalized(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): { x: number; y: number } {
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

export function AnnotationLayer({
  annotations,
  tool,
  defaultColor,
  selectedId,
  onSelect,
  onAdd,
  onUpdate,
  readOnly = false,
}: AnnotationLayerProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragRect, setDragRect] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const pinDragRef = useRef<{ id: string; pointerId: number } | null>(null);

  const nextOrder = annotations.length + 1;

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (readOnly) return;
      if (e.target !== e.currentTarget) return; // clicked on an existing marker
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const p = toNormalized(e.clientX, e.clientY, rect);

      if (tool === "pin") {
        const pin: PinAnnotation = {
          id: makeId(),
          kind: "pin",
          x: p.x,
          y: p.y,
          note: "",
          color: defaultColor,
          order: nextOrder,
        };
        onAdd(pin);
        onSelect(pin.id);
        return;
      }
      if (tool === "rect") {
        setDragRect({ start: p, current: p });
        svg.setPointerCapture(e.pointerId);
        return;
      }
      // select tool — clicking empty space deselects
      onSelect(null);
    },
    [readOnly, tool, defaultColor, nextOrder, onAdd, onSelect],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const p = toNormalized(e.clientX, e.clientY, rect);

      if (dragRect) {
        setDragRect({ start: dragRect.start, current: p });
        return;
      }
      const pinDrag = pinDragRef.current;
      if (pinDrag) {
        onUpdate(pinDrag.id, { x: p.x, y: p.y });
      }
    },
    [dragRect, onUpdate],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (svg && svg.hasPointerCapture(e.pointerId)) {
        svg.releasePointerCapture(e.pointerId);
      }
      if (dragRect) {
        const x = Math.min(dragRect.start.x, dragRect.current.x);
        const y = Math.min(dragRect.start.y, dragRect.current.y);
        const w = Math.abs(dragRect.current.x - dragRect.start.x);
        const h = Math.abs(dragRect.current.y - dragRect.start.y);
        setDragRect(null);
        // Ignore zero-area drags (a click rather than a drag).
        if (w > 0.005 && h > 0.005) {
          const rect: RectAnnotation = {
            id: makeId(),
            kind: "rect",
            x,
            y,
            w,
            h,
            note: "",
            color: defaultColor,
            order: nextOrder,
          };
          onAdd(rect);
          onSelect(rect.id);
        }
      }
      pinDragRef.current = null;
    },
    [dragRect, defaultColor, nextOrder, onAdd, onSelect],
  );

  const startPinDrag = useCallback(
    (e: ReactPointerEvent<SVGGElement>, id: string) => {
      if (readOnly || tool !== "select") return;
      e.stopPropagation();
      onSelect(id);
      pinDragRef.current = { id, pointerId: e.pointerId };
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [readOnly, tool, onSelect],
  );

  const cursor = readOnly
    ? "default"
    : tool === "pin"
      ? "crosshair"
      : tool === "rect"
        ? "crosshair"
        : "default";

  return (
    <svg
      ref={svgRef}
      data-testid="annotation-layer"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        cursor,
        touchAction: "none",
        pointerEvents: readOnly ? "none" : "auto",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {annotations.map((a) =>
        a.kind === "rect" ? (
          <g
            key={a.id}
            onPointerDown={(e) => {
              if (readOnly || tool !== "select") return;
              e.stopPropagation();
              onSelect(a.id);
            }}
          >
            <rect
              x={a.x * 100}
              y={a.y * 100}
              width={a.w * 100}
              height={a.h * 100}
              fill={a.color}
              fillOpacity={selectedId === a.id ? 0.18 : 0.1}
              stroke={a.color}
              strokeWidth={selectedId === a.id ? 0.5 : 0.3}
              strokeDasharray="1 0.6"
              vectorEffect="non-scaling-stroke"
              style={{ cursor: readOnly ? "default" : "pointer" }}
            />
            <text
              x={a.x * 100 + 0.8}
              y={a.y * 100 + 3.2}
              fill={a.color}
              fontSize={3}
              fontWeight={600}
              style={{ pointerEvents: "none", fontFamily: "var(--font-mono)" }}
            >
              {a.order}
            </text>
          </g>
        ) : (
          <g
            key={a.id}
            data-testid={`pin-${a.id}`}
            onPointerDown={(e) => startPinDrag(e, a.id)}
            style={{ cursor: readOnly ? "default" : "grab" }}
          >
            <circle
              cx={a.x * 100}
              cy={a.y * 100}
              r={selectedId === a.id ? 2.2 : 1.8}
              fill={a.color}
              stroke="#fff"
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={a.x * 100}
              y={a.y * 100 + 0.7}
              fill="#fff"
              fontSize={1.9}
              fontWeight={700}
              textAnchor="middle"
              style={{ pointerEvents: "none", fontFamily: "var(--font-mono)" }}
            >
              {a.order}
            </text>
          </g>
        ),
      )}
      {dragRect && (
        <rect
          x={Math.min(dragRect.start.x, dragRect.current.x) * 100}
          y={Math.min(dragRect.start.y, dragRect.current.y) * 100}
          width={Math.abs(dragRect.current.x - dragRect.start.x) * 100}
          height={Math.abs(dragRect.current.y - dragRect.start.y) * 100}
          fill={defaultColor}
          fillOpacity={0.15}
          stroke={defaultColor}
          strokeWidth={0.3}
          strokeDasharray="1 0.6"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
    </svg>
  );
}
