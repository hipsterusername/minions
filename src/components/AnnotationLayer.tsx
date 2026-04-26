/**
 * Annotation layer — an SVG overlay that owns pin and rectangle markup
 * in normalized (0–1) coordinates, so annotations survive container
 * resize / zoom. Reused by ImageNode today and by WebPreviewNode /
 * PdfPageNode later (Phase 4 of docs/visual-context-plan.md).
 *
 * Coordinates are always stored as ratios of the container's rendered
 * size. Pixel math happens on read/write at the event boundary.
 *
 * Interaction model — standard "create/edit" with one active tool
 * (Pin or Rect). The tool acts on empty space; existing marks are
 * always editable in place:
 *   - Click empty space ⇒ create a new mark of the active tool's kind
 *     (pin: tap, rect: drag-to-size).
 *   - Click an existing mark ⇒ select it.
 *   - Drag a selected mark by its body ⇒ move it.
 *   - Drag a selected rect's corner handle ⇒ resize it.
 * No separate "Select" mode: the assumption is that placing a new mark
 * exactly on top of an existing one is rare, and dispatching by hit-test
 * (mark vs. empty space) covers the common cases without an extra modal
 * tool the user must remember to switch out of.
 */
import {
  useRef,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type AnnotationTool = "pin" | "rect";

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
  /**
   * width/height aspect ratio of the host's content box. Used to size the
   * SVG viewBox so a circle renders as an actual circle and a resize
   * handle stays square — regardless of how non-square the image is.
   * Defaults to 1 (square) for hosts that don't pass it.
   */
  aspectRatio?: number;
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

/** Next stable order value: one above the current max, or 1 when empty.
 *  Using the max (rather than `length + 1`) keeps numbers unique across
 *  delete cycles — important now that we no longer renumber on delete. */
function nextOrderFor(annotations: ReadonlyArray<Annotation>): number {
  let max = 0;
  for (const a of annotations) if (a.order > max) max = a.order;
  return max + 1;
}

/** Which of the eight resize anchors is being dragged. */
type RectHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface RectMoveDrag {
  kind: "move";
  id: string;
  pointerId: number;
  /** Grab offset from the rect's top-left, in normalized units. */
  offset: { x: number; y: number };
}

interface RectResizeDrag {
  kind: "resize";
  id: string;
  pointerId: number;
  handle: RectHandle;
  /** The rect's state at drag start — we reshape against this, not the
   *  current render, so mid-drag rounding doesn't drift. */
  origin: { x: number; y: number; w: number; h: number };
}

type RectDrag = RectMoveDrag | RectResizeDrag;

export function AnnotationLayer({
  annotations,
  tool,
  defaultColor,
  selectedId,
  onSelect,
  onAdd,
  onUpdate,
  readOnly = false,
  aspectRatio = 1,
}: AnnotationLayerProps): React.JSX.Element {
  // Build a viewBox whose aspect ratio matches the host content box. With
  // a matching aspect we can use the default `preserveAspectRatio` (no
  // `none`) and circles stay circular at any image proportion.
  // The shorter axis is normalised to 100 units; the longer axis is
  // 100 * aspectRatio (or 100 / aspectRatio). Coordinates remain stored
  // as 0–1 normalised — render math just multiplies by vbW / vbH.
  const safeAspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const vbW = safeAspect >= 1 ? 100 * safeAspect : 100;
  const vbH = safeAspect >= 1 ? 100 : 100 / safeAspect;
  // Visual sizes scale off the SHORTER side so marks read at a consistent
  // size whether the image is wide, tall, or square.
  const shortSide = Math.min(vbW, vbH);
  const PIN_R = shortSide * 0.022;
  const PIN_R_SELECTED = shortSide * 0.027;
  const PIN_HALO_R = shortSide * 0.042;
  const PIN_LABEL_FONT = shortSide * 0.024;
  const RECT_LABEL_FONT = shortSide * 0.034;
  const RECT_STROKE = shortSide * 0.0035;
  const RECT_STROKE_SELECTED = shortSide * 0.008;
  const HANDLE_SIZE = shortSide * 0.018;
  const HANDLE_STROKE = shortSide * 0.005;
  const PIN_STROKE = shortSide * 0.005;
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragRect, setDragRect] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const pinDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const rectDragRef = useRef<RectDrag | null>(null);

  const nextOrder = nextOrderFor(annotations);

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
      // tool === "rect"
      setDragRect({ start: p, current: p });
      svg.setPointerCapture(e.pointerId);
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
        return;
      }
      const rd = rectDragRef.current;
      if (!rd) return;
      if (rd.kind === "move") {
        // Keep the rect fully inside [0,1]; we know w/h from the current annotation.
        const target = annotations.find((a) => a.id === rd.id);
        if (!target || target.kind !== "rect") return;
        const nx = clamp01(p.x - rd.offset.x);
        const ny = clamp01(p.y - rd.offset.y);
        const clampedX = Math.min(nx, 1 - target.w);
        const clampedY = Math.min(ny, 1 - target.h);
        onUpdate(rd.id, { x: clampedX, y: clampedY });
      } else {
        const o = rd.origin;
        let { x, y, w, h } = o;
        if (rd.handle.includes("n")) {
          const dy = p.y - o.y;
          y = clamp01(o.y + dy);
          h = clamp01(o.h - dy);
        }
        if (rd.handle.includes("s")) {
          h = clamp01(p.y - o.y);
        }
        if (rd.handle.includes("w")) {
          const dx = p.x - o.x;
          x = clamp01(o.x + dx);
          w = clamp01(o.w - dx);
        }
        if (rd.handle.includes("e")) {
          w = clamp01(p.x - o.x);
        }
        // Don't flip through zero — keep a minimum footprint.
        const MIN = 0.005;
        if (w < MIN) w = MIN;
        if (h < MIN) h = MIN;
        onUpdate(rd.id, { x, y, w, h });
      }
    },
    [dragRect, onUpdate, annotations],
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
      rectDragRef.current = null;
    },
    [dragRect, defaultColor, nextOrder, onAdd, onSelect],
  );

  const startPinDrag = useCallback(
    (e: ReactPointerEvent<SVGGElement>, id: string) => {
      if (readOnly) return;
      e.stopPropagation();
      onSelect(id);
      // Existing marks are always editable in place — drag works under
      // any active tool. The "select" modal mode is gone; create-vs-edit
      // is decided by hit test (mark vs. empty space).
      pinDragRef.current = { id, pointerId: e.pointerId };
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [readOnly, onSelect],
  );

  const startRectDrag = useCallback(
    (e: ReactPointerEvent<SVGGElement>, rect: RectAnnotation) => {
      if (readOnly) return;
      e.stopPropagation();
      onSelect(rect.id);
      const svg = svgRef.current;
      if (!svg) return;
      const svgRect = svg.getBoundingClientRect();
      const p = toNormalized(e.clientX, e.clientY, svgRect);
      rectDragRef.current = {
        kind: "move",
        id: rect.id,
        pointerId: e.pointerId,
        offset: { x: p.x - rect.x, y: p.y - rect.y },
      };
      svg.setPointerCapture(e.pointerId);
    },
    [readOnly, onSelect],
  );

  const startRectResize = useCallback(
    (e: ReactPointerEvent<SVGRectElement>, rect: RectAnnotation, handle: RectHandle) => {
      if (readOnly) return;
      e.stopPropagation();
      rectDragRef.current = {
        kind: "resize",
        id: rect.id,
        pointerId: e.pointerId,
        handle,
        origin: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      };
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [readOnly],
  );

  const cursor = readOnly ? "default" : "crosshair";

  return (
    <svg
      ref={svgRef}
      data-testid="annotation-layer"
      data-no-drag
      viewBox={`0 0 ${vbW} ${vbH}`}
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
            data-testid={`rect-${a.id}`}
            onPointerDown={(e) => startRectDrag(e, a)}
            style={{ cursor: readOnly ? "default" : "move" }}
          >
            <rect
              x={a.x * vbW}
              y={a.y * vbH}
              width={a.w * vbW}
              height={a.h * vbH}
              rx={shortSide * 0.004}
              fill={a.color}
              fillOpacity={selectedId === a.id ? 0.18 : 0.08}
              stroke={a.color}
              strokeWidth={selectedId === a.id ? RECT_STROKE_SELECTED : RECT_STROKE}
              strokeDasharray={
                selectedId === a.id ? undefined : `${shortSide * 0.012} ${shortSide * 0.008}`
              }
              vectorEffect="non-scaling-stroke"
            />
            {/* Order chip — a filled pill on the rect's top-left corner so
                the number reads regardless of the rect's fill colour. */}
            <g pointerEvents="none">
              <circle
                cx={a.x * vbW + shortSide * 0.026}
                cy={a.y * vbH + shortSide * 0.026}
                r={shortSide * 0.022}
                fill={a.color}
                stroke="#fff"
                strokeWidth={shortSide * 0.004}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={a.x * vbW + shortSide * 0.026}
                y={a.y * vbH + shortSide * 0.026 + RECT_LABEL_FONT * 0.36}
                fill="#fff"
                fontSize={RECT_LABEL_FONT * 0.78}
                fontWeight={700}
                textAnchor="middle"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {a.order}
              </text>
            </g>
            {selectedId === a.id && !readOnly && (
              <RectHandles
                rect={a}
                vbW={vbW}
                vbH={vbH}
                size={HANDLE_SIZE}
                strokeWidth={HANDLE_STROKE}
                onStart={startRectResize}
              />
            )}
          </g>
        ) : (
          <g
            key={a.id}
            data-testid={`pin-${a.id}`}
            onPointerDown={(e) => startPinDrag(e, a.id)}
            style={{ cursor: readOnly ? "default" : "grab" }}
          >
            {/* Halo for the selected pin so it reads at a glance amid peers. */}
            {selectedId === a.id && (
              <circle
                cx={a.x * vbW}
                cy={a.y * vbH}
                r={PIN_HALO_R}
                fill="none"
                stroke={a.color}
                strokeOpacity={0.5}
                strokeWidth={PIN_STROKE * 1.6}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
            <circle
              cx={a.x * vbW}
              cy={a.y * vbH}
              r={selectedId === a.id ? PIN_R_SELECTED : PIN_R}
              fill={a.color}
              stroke="#fff"
              strokeWidth={PIN_STROKE}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={a.x * vbW}
              y={a.y * vbH + PIN_LABEL_FONT * 0.36}
              fill="#fff"
              fontSize={PIN_LABEL_FONT}
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
          x={Math.min(dragRect.start.x, dragRect.current.x) * vbW}
          y={Math.min(dragRect.start.y, dragRect.current.y) * vbH}
          width={Math.abs(dragRect.current.x - dragRect.start.x) * vbW}
          height={Math.abs(dragRect.current.y - dragRect.start.y) * vbH}
          rx={shortSide * 0.004}
          fill={defaultColor}
          fillOpacity={0.14}
          stroke={defaultColor}
          strokeWidth={RECT_STROKE}
          strokeDasharray={`${shortSide * 0.012} ${shortSide * 0.008}`}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
    </svg>
  );
}

// ── Rect resize handles ────────────────────────────────

interface RectHandlesProps {
  rect: RectAnnotation;
  vbW: number;
  vbH: number;
  size: number;
  strokeWidth: number;
  onStart: (
    e: ReactPointerEvent<SVGRectElement>,
    rect: RectAnnotation,
    handle: RectHandle,
  ) => void;
}

const HANDLE_POSITIONS: ReadonlyArray<{ handle: RectHandle; at: (r: RectAnnotation) => { x: number; y: number }; cursor: string }> = [
  { handle: "nw", at: (r) => ({ x: r.x, y: r.y }), cursor: "nwse-resize" },
  { handle: "n",  at: (r) => ({ x: r.x + r.w / 2, y: r.y }), cursor: "ns-resize" },
  { handle: "ne", at: (r) => ({ x: r.x + r.w, y: r.y }), cursor: "nesw-resize" },
  { handle: "e",  at: (r) => ({ x: r.x + r.w, y: r.y + r.h / 2 }), cursor: "ew-resize" },
  { handle: "se", at: (r) => ({ x: r.x + r.w, y: r.y + r.h }), cursor: "nwse-resize" },
  { handle: "s",  at: (r) => ({ x: r.x + r.w / 2, y: r.y + r.h }), cursor: "ns-resize" },
  { handle: "sw", at: (r) => ({ x: r.x, y: r.y + r.h }), cursor: "nesw-resize" },
  { handle: "w",  at: (r) => ({ x: r.x, y: r.y + r.h / 2 }), cursor: "ew-resize" },
];

function RectHandles({
  rect,
  vbW,
  vbH,
  size,
  strokeWidth,
  onStart,
}: RectHandlesProps): React.JSX.Element {
  return (
    <g data-testid={`rect-handles-${rect.id}`}>
      {HANDLE_POSITIONS.map(({ handle, at, cursor }) => {
        const { x, y } = at(rect);
        return (
          <rect
            key={handle}
            data-testid={`rect-handle-${rect.id}-${handle}`}
            x={x * vbW - size / 2}
            y={y * vbH - size / 2}
            width={size}
            height={size}
            fill="#fff"
            stroke={rect.color}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
            style={{ cursor }}
            onPointerDown={(e) => onStart(e, rect, handle)}
          />
        );
      })}
    </g>
  );
}
