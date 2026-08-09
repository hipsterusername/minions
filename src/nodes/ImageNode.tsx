/**
 * ImageNode — drops/pastes a raster image onto the canvas and lets the
 * user mark it up with pins and rectangles. The resulting
 * image-plus-annotations flows as context to a connected Leader.
 *
 * Implementation scope:
 *   • UI: this node, the AnnotationLayer, the AnnotationSidebar,
 *     and the paste/drop plumbing in Canvas.tsx.
 *   • Image bytes ride the multimodal
 *     attachment channel as a real `image` block, and any pin/rect
 *     annotations are RASTERIZED into those bytes before they leave
 *     the renderer (see `./rasterize-annotations.ts`). The complementary
 *     text description in `extractImageNodeContent` still rides the
 *     `ContextPayload.content` channel — the model uses the textual
 *     coordinates and notes to cross-reference each numbered marker
 *     stamped on the image.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContextAttachment, NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, CONTEXT_OUT_PORT } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import {
  AnnotationLayer,
  type Annotation,
  type AnnotationTool,
} from "../components/AnnotationLayer.tsx";
import { AnnotationSidebar } from "../components/AnnotationSidebar.tsx";
import { MARKUP_PALETTE } from "../components/markup-palette.ts";
import { loadImageFromFile } from "./image-loader.ts";
import {
  rasterizeAnnotatedImage,
  lookupRasterizedAnnotatedImage,
} from "./rasterize-annotations.ts";
import { browserLogger } from "../logging.ts";

const log = browserLogger.child("image-node");

// ── Data shape ──────────────────────────────────────────

export interface ImageNodeData {
  /**
   * Image source. Today: a `data:` URL. Phase 2 replaces this with an
   * `AssetRef` pointer into the server asset store; the renderer
   * resolves it to a URL for display.
   */
  src: string | null;
  /** Natural pixel dimensions of the source image. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Original filename (from drop) or a generated label. */
  filename?: string;
  /** Pin / rectangle markup in normalized 0–1 coordinates. */
  annotations: Annotation[];
  /** Markup toolbar state. */
  selectedTool?: AnnotationTool;
  selectedAnnotationId?: string | null;
  defaultColor?: string;
}

// ── Graph contract ─────────────────────────────────────

const IMAGE_CONTRACT: NodeInterfaceContract = {
  nodeType: "image",
  label: "Image",
  description:
    "A pasted or dropped image with optional pin / rectangle markup. " +
    "Connects as context to a Leader; the Leader receives the image " +
    "and the annotations together.",
  ports: [CONTEXT_OUT_PORT],
};

registerContract(IMAGE_CONTRACT);

// ── Defaults ───────────────────────────────────────────

export const IMAGE_NODE_DEFAULT_COLOR = MARKUP_PALETTE[0]?.color ?? "#3b82f6";

export function createImageNodeDefaultData(): ImageNodeData {
  return {
    src: null,
    annotations: [],
    selectedTool: "pin",
    selectedAnnotationId: null,
    defaultColor: IMAGE_NODE_DEFAULT_COLOR,
  };
}

// ── Content extractor ──────────────────────────────────

/**
 * Parse a `data:image/<type>;base64,<payload>` URL into the pieces the
 * Anthropic SDK's {@link Base64ImageSource} expects. Returns null for
 * non-data URLs or unsupported media types — we silently drop rather
 * than attach an unusable image.
 */
const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

function parseDataUrl(
  src: string,
): { mediaType: SupportedImageMediaType; data: string } | null {
  // Expected shape: data:<mime>;base64,<payload>
  if (!src.startsWith("data:")) return null;
  const comma = src.indexOf(",");
  if (comma < 0) return null;
  const header = src.slice(5, comma); // after "data:"
  const [mime, encoding] = header.split(";");
  if (encoding !== "base64" || !mime) return null;
  const normalized = mime.toLowerCase();
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(normalized as SupportedImageMediaType)) {
    return null;
  }
  return {
    mediaType: normalized as SupportedImageMediaType,
    data: src.slice(comma + 1),
  };
}

/**
 * Extract the actual image bytes so the leader can send them as a real
 * {@link ImageBlockParam} in its first user turn. Without this, the
 * model only ever sees the text description from {@link extractImageNodeContent}
 * and hallucinates the contents — the bug the user reported.
 *
 * When the user has drawn pins / rectangles, prefer the rasterized
 * version cached by {@link rasterizeAnnotatedImage} so the model sees
 * the same numbered markers the user does. The cache is populated by
 * a debounced effect in {@link ImageNodeRenderer} as soon as the
 * annotation set settles. If the user fires a leader before the
 * background raster finishes, we fall back to the unannotated source
 * — the textual annotation list still rides alongside via
 * {@link extractImageNodeContent}, so the model is never blind to the
 * marks, only their visual positions.
 */
export function extractImageNodeAttachments(data: unknown): ContextAttachment[] | null {
  const d = data as ImageNodeData | undefined;
  if (!d?.src) return null;
  const annotated = lookupRasterizedAnnotatedImage(d.src, d.annotations ?? []);
  const sourceUrl = annotated ?? d.src;
  const parsed = parseDataUrl(sourceUrl);
  if (!parsed) return null;
  return [
    {
      kind: "image",
      mediaType: parsed.mediaType,
      data: parsed.data,
      ...(d.filename ? { filename: d.filename } : {}),
    },
  ];
}

/**
 * Flatten an ImageNode's text-side context. The image *bytes* travel
 * separately via {@link extractImageNodeAttachments}; this function is
 * responsible for the complementary human/agent-readable preamble —
 * filename, dimensions, and annotation notes — so the model knows how
 * to talk about what it's seeing in the attached image.
 */
export function extractImageNodeContent(data: unknown): string | null {
  const d = data as ImageNodeData | undefined;
  if (!d?.src) return null;
  const parts: string[] = [];
  const dims = d.naturalWidth && d.naturalHeight
    ? `${d.naturalWidth}×${d.naturalHeight}`
    : "unknown size";
  parts.push(`[Image: ${d.filename ?? "untitled"}, ${dims}]`);
  const anns = [...(d.annotations ?? [])].sort((a, b) => a.order - b.order);
  if (anns.length > 0) {
    parts.push("");
    parts.push("Annotations (coordinates are 0–1 normalized, origin top-left):");
    for (const a of anns) {
      if (a.kind === "pin") {
        parts.push(
          `${a.order}. Pin at (${a.x.toFixed(3)}, ${a.y.toFixed(3)})` +
            (a.note ? `: "${a.note}"` : " (no note)"),
        );
      } else {
        parts.push(
          `${a.order}. Rect from (${a.x.toFixed(3)}, ${a.y.toFixed(3)}) ` +
            `to (${(a.x + a.w).toFixed(3)}, ${(a.y + a.h).toFixed(3)})` +
            (a.note ? `: "${a.note}"` : " (no note)"),
        );
      }
    }
  }
  return parts.join("\n");
}

// ── Component ──────────────────────────────────────────

export function ImageNodeRenderer({
  node,
  onUpdateData,
  isSelected,
}: NodeRenderProps): React.JSX.Element {
  const data = node.data as ImageNodeData;
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror the latest node.data in a ref so `update()` always composes its
  // patch against the freshest value. Without this, two `update()` calls
  // fired in the same pointerdown (e.g. addAnnotation + setSelected when
  // a pin is placed) each spread from their own stale closure of `data`,
  // and the second call clobbers the first — the hallmark symptom being
  // "click places a pin, but toolbar still reports 'no marks'".
  const dataRef = useRef(data);
  dataRef.current = data;

  const update = useCallback(
    (patch: Partial<ImageNodeData>) => {
      const next = { ...dataRef.current, ...patch };
      // Write through to the ref synchronously so a second update() in the
      // same event (e.g. addAnnotation followed by setSelected on pin-drop)
      // composes against the freshly-patched data rather than the pre-event
      // snapshot. The ref resyncs to node.data at the top of the next render.
      dataRef.current = next;
      onUpdateData(next);
    },
    [onUpdateData],
  );

  const loadFile = useCallback(
    async (file: File): Promise<void> => {
      if (!file.type.startsWith("image/")) return;
      setLoading(true);
      try {
        const loaded = await loadImageFromFile(file);
        onUpdateData({
          ...data,
          src: loaded.src,
          naturalWidth: loaded.naturalWidth,
          naturalHeight: loaded.naturalHeight,
          filename: loaded.filename,
        });
      } finally {
        setLoading(false);
      }
    },
    [data, onUpdateData],
  );

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void loadFile(file);
      e.target.value = "";
    },
    [loadFile],
  );

  const onDropImage = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      if (data.src) return; // occupied slot — let the outer canvas handle it
      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      e.preventDefault();
      e.stopPropagation();
      await loadFile(file);
    },
    [data.src, loadFile],
  );

  // Respect OS reduced-motion preference for the idle pulse on empty state.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const handler = (e: MediaQueryListEvent): void => setReduceMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Eagerly rasterize annotations into the image bytes so the leader's
  // attachment extractor finds a fresh render in the cache by the time
  // the user clicks send. Debounced 250ms so we don't re-encode on
  // every pointermove during a drag — the user lands at rest, we
  // rasterize once. Errors are non-fatal: extractImageNodeAttachments
  // falls back to the unannotated src + textual coordinates.
  const { src, naturalWidth, naturalHeight, annotations } = data;
  useEffect(() => {
    if (!src || !naturalWidth || !naturalHeight) return;
    if (!annotations || annotations.length === 0) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void rasterizeAnnotatedImage(src, annotations, naturalWidth, naturalHeight).catch(
        (err: unknown) => {
          if (cancelled) return;
          log.warn("annotation_rasterize_failed", { error: err });
        },
      );
    }, 250);
    return (): void => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [src, naturalWidth, naturalHeight, annotations]);

  // Persisted nodes from before the create/edit refactor may carry a
  // legacy `selectedTool: "select"` value. Coerce anything that isn't
  // one of the current tools back to the default rather than leaving
  // the layer in an unhandled state.
  const tool: AnnotationTool =
    data.selectedTool === "rect" ? "rect" : "pin";
  const color = data.defaultColor ?? IMAGE_NODE_DEFAULT_COLOR;
  const selected = data.annotations.find((a) => a.id === data.selectedAnnotationId) ?? null;

  // ── Annotation callbacks ─────────────────────────────
  // All annotation mutations read through dataRef so they see the freshest
  // list even when multiple callbacks fire in the same event (e.g. a pin
  // placement is add + select back-to-back).
  const addAnnotation = useCallback(
    (a: Annotation) => {
      update({ annotations: [...dataRef.current.annotations, a] });
    },
    [update],
  );
  const updateAnnotation = useCallback(
    (id: string, patch: Partial<Annotation>) => {
      update({
        annotations: dataRef.current.annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      });
    },
    [update],
  );
  const deleteAnnotation = useCallback(
    (id: string) => {
      const current = dataRef.current;
      // Do NOT renumber remaining marks: `order` is a stable label users
      // may reference from inside another mark's note ("see #3 above") or
      // from external notes. Silent renumbering on delete turned those
      // references into lies. Gaps in the numbering are acceptable; new
      // marks pick up max(order)+1 in AnnotationLayer.
      const next = current.annotations.filter((a) => a.id !== id);
      const nextSelected =
        current.selectedAnnotationId === id ? null : (current.selectedAnnotationId ?? null);
      update({ annotations: next, selectedAnnotationId: nextSelected });
    },
    [update],
  );
  const setSelected = useCallback(
    (id: string | null) => {
      update({ selectedAnnotationId: id });
    },
    [update],
  );
  const clearAllAnnotations = useCallback(() => {
    update({ annotations: [], selectedAnnotationId: null });
  }, [update]);

  // Palette click: recolour the selected mark when one is selected, fall
  // back to setting the default for *future* marks otherwise. The old
  // behaviour always changed the default, so users who selected a pin and
  // clicked red saw nothing happen to that pin — the "category-colour
  // after placement" workflow was impossible.
  const handleColorChange = useCallback(
    (c: string) => {
      const current = dataRef.current;
      if (current.selectedAnnotationId) {
        updateAnnotation(current.selectedAnnotationId, { color: c });
      } else {
        update({ defaultColor: c });
      }
    },
    [update, updateAnnotation],
  );

  // ── Sync annotation layer bounds to the rendered image ────
  // The image is centered in the flex stage with `maxWidth/maxHeight: 100%`,
  // which means it rarely fills the whole stage. If the AnnotationLayer
  // spanned the full stage (its old behavior), pins placed near the image
  // would land in the letterbox and look like they "didn't register".
  //
  // We compute the rendered image box deterministically from the stage's
  // measured size plus the image's natural aspect ratio — the same math
  // the browser does for `object-fit: contain`. This avoids a read/write
  // race against the <img> element's own getBoundingClientRect.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Use clientWidth/clientHeight, NOT getBoundingClientRect. The canvas
    // applies a CSS transform for zoom, and getBoundingClientRect returns
    // the *visual* (post-transform) box — feeding those numbers into the
    // imgBox calc below produces an overlay sized in scaled pixels but
    // applied as CSS pixels, so the pinnable area drifts off the actual
    // image as soon as the user zooms. clientWidth/clientHeight return the
    // unscaled layout box, which is what CSS top/left/width/height expect.
    const sync = (): void => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (w > 0 && h > 0) {
        setStageSize({ width: w, height: h });
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const imgBox = useMemo(() => {
    if (!stageSize || !data.naturalWidth || !data.naturalHeight) return null;
    const { width: sw, height: sh } = stageSize;
    if (sw <= 0 || sh <= 0) return null;
    const imgRatio = data.naturalWidth / data.naturalHeight;
    const stageRatio = sw / sh;
    const [w, h] = imgRatio > stageRatio
      ? [sw, sw / imgRatio]
      : [sh * imgRatio, sh];
    return {
      width: w,
      height: h,
      top: (sh - h) / 2,
      left: (sw - w) / 2,
    };
  }, [stageSize, data.naturalWidth, data.naturalHeight]);

  return (
    <div
      data-testid="image-node"
      onDragOver={(e) => {
        if (!data.src && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => { void onDropImage(e); }}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderRadius: 10,
        border: `1px solid ${isSelected ? "color-mix(in srgb, var(--accent) 55%, transparent)" : "var(--border-default)"}`,
        overflow: "hidden",
        boxShadow: isSelected ? "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)" : "none",
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 10px",
          borderBottom: "1px solid var(--border-default)",
          background: "color-mix(in srgb, var(--bg-secondary) 70%, transparent)",
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 4,
            background: "color-mix(in srgb, var(--accent) 14%, transparent)",
            color: "var(--accent)",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-primary)",
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.filename ?? "Image"}
        </span>
        {data.annotations.length > 0 && (
          <span
            data-testid="header-mark-count"
            aria-label={`${data.annotations.length} annotation${data.annotations.length === 1 ? "" : "s"}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              padding: "1px 6px",
              borderRadius: 999,
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
            }}
          >
            <span style={{
              width: 5, height: 5, borderRadius: 999,
              background: "var(--accent)",
            }} />
            {data.annotations.length}
          </span>
        )}
        {data.naturalWidth && data.naturalHeight && (
          <span style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}>
            {data.naturalWidth}{"×"}{data.naturalHeight}
          </span>
        )}
      </div>

      {/* Body: image stage + fixed-width sidebar. Keeping the sidebar
          as a flex:0 sibling means adding marks never squeezes the
          image — the list scrolls inside the sidebar instead. */}
      <div
        data-testid="image-node-body"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
        }}
      >
        <div
          ref={stageRef}
          data-testid="image-stage"
          style={{
            flex: 1,
            position: "relative",
            background: "var(--bg-primary)",
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {data.src && imgBox ? (
            /*
             * Single positioned box that holds BOTH the <img> and the
             * AnnotationLayer SVG. They share one parent sized exactly to
             * imgBox, so the rendered image and the pinnable area are
             * structurally guaranteed to agree — pixel for pixel, at any
             * canvas zoom and on any image aspect.
             *
             * Earlier revisions used object-fit:contain on an <img> that
             * filled the whole stage and computed the overlay separately:
             * sub-pixel rounding and the canvas zoom transform let the two
             * boxes drift, so users saw pins land on the letterbox or
             * couldn't reach the top edge of the image.
             */
            <div
              data-testid="annotation-overlay"
              style={{
                position: "absolute",
                top: imgBox.top,
                left: imgBox.left,
                width: imgBox.width,
                height: imgBox.height,
                /* Belt-and-braces: even if a child somehow tried to grow
                 * past the overlay box, clip it here. Prevents the image
                 * (or any overlay artefact) from leaking into the rest
                 * of the node. */
                overflow: "hidden",
              }}
            >
              <img
                src={data.src}
                alt={data.filename ?? "Pasted image"}
                draggable={false}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  /* Overlay's aspect already matches the image's natural
                   * aspect (imgBox is computed with the same fit math),
                   * so `contain` is a no-op visually — but it's a hard
                   * guarantee that the rendered image content cannot
                   * exceed the overlay's pixel bounds, no matter what
                   * sub-pixel rounding the browser does. */
                  objectFit: "contain",
                  display: "block",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
              <AnnotationLayer
                annotations={data.annotations}
                tool={tool}
                defaultColor={color}
                selectedId={data.selectedAnnotationId ?? null}
                onSelect={setSelected}
                onAdd={addAnnotation}
                onUpdate={updateAnnotation}
                aspectRatio={data.naturalWidth && data.naturalHeight
                  ? data.naturalWidth / data.naturalHeight
                  : 1}
              />
            </div>
          ) : data.src ? (
            /* Image bytes loaded but stage hasn't been measured yet. Show
             * the image filling the stage as a placeholder (no annotation
             * layer) — useLayoutEffect will set stageSize on the same tick
             * and swap to the aligned overlay above. */
            <img
              src={data.src}
              alt={data.filename ?? "Pasted image"}
              draggable={false}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                display: "block",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          ) : (
            <EmptyState
              loading={loading}
              reduceMotion={reduceMotion}
              onPick={() => inputRef.current?.click()}
            />
          )}
        </div>

        {data.src && (
          <AnnotationSidebar
            tool={tool}
            color={color}
            selected={selected}
            annotations={data.annotations}
            onToolChange={(t) => update({ selectedTool: t })}
            onColorChange={handleColorChange}
            onNoteChange={(id, note) => updateAnnotation(id, { note })}
            onSelect={setSelected}
            onDelete={deleteAnnotation}
            onClearAll={clearAllAnnotations}
          />
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onFileInputChange}
      />
    </div>
  );
}

// ── Empty state ────────────────────────────────────────

interface EmptyStateProps {
  loading: boolean;
  reduceMotion: boolean;
  onPick: () => void;
}

function EmptyState({ loading, reduceMotion, onPick }: EmptyStateProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={loading}
      aria-label={loading ? "Loading image" : "Add an image"}
      style={{
        position: "absolute",
        inset: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        border: "1.5px dashed color-mix(in srgb, var(--accent) 40%, transparent)",
        borderRadius: 10,
        background: "color-mix(in srgb, var(--accent) 3%, transparent)",
        color: "var(--text-muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        cursor: loading ? "progress" : "pointer",
        opacity: reduceMotion ? 1 : undefined,
        animation: reduceMotion ? undefined : "imageNodePulse 2.4s ease-in-out infinite",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 44,
          height: 44,
          borderRadius: 10,
          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
          color: "var(--accent)",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M21 16l-5-5-9 9" />
        </svg>
      </span>
      <span
        style={{
          textAlign: "center",
          lineHeight: 1.4,
          color: "var(--text-primary)",
          fontWeight: 600,
        }}
      >
        {loading ? "Loading…" : "Add an image"}
      </span>
      {!loading && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            letterSpacing: "0.04em",
          }}
        >
          <Kbd>drop</Kbd>
          <span style={{ opacity: 0.5 }}>·</span>
          <Kbd>paste</Kbd>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>click to pick</span>
        </span>
      )}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd
      style={{
        padding: "1px 6px",
        borderRadius: 4,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {children}
    </kbd>
  );
}

// ── Keyframes (inject once) ────────────────────────────

let pulseInjected = false;
function injectKeyframes(): void {
  if (pulseInjected || typeof document === "undefined") return;
  pulseInjected = true;
  const el = document.createElement("style");
  el.textContent = `@keyframes imageNodePulse {
  0%, 100% { background: color-mix(in srgb, var(--accent) 3%, transparent); }
  50% { background: color-mix(in srgb, var(--accent) 7%, transparent); }
}`;
  document.head.appendChild(el);
}
injectKeyframes();

// ── Registration ───────────────────────────────────────

registerNodeType({
  type: "image",
  label: "Image",
  // Width accounts for the fixed-width AnnotationSidebar (~184px) —
  // the image area needs a comfortable minimum beside it.
  defaultSize: { width: 600, height: 440 },
  render: ImageNodeRenderer,
  userCreatable: false,
  providesContext: true,
  extractContent: extractImageNodeContent,
  extractAttachments: extractImageNodeAttachments,
});
