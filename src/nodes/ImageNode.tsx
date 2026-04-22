/**
 * ImageNode — drops/pastes a raster image onto the canvas and lets the
 * user mark it up with pins and rectangles. The resulting
 * image-plus-annotations flows as context to a connected Leader.
 *
 * Phase scope — see `docs/visual-context-plan.md`:
 *   • Phase 3 UI: this node, the AnnotationLayer, the MarkupToolbar,
 *     and the paste/drop plumbing in Canvas.tsx.
 *   • Phase 1/2 (not landed yet): the shared ContextBlock union, the
 *     server asset store, and the multimodal SDK pipeline. Until those
 *     land, this node stores the image as a `data:` URL on node.data
 *     and `extractContent` returns a structured *text* description
 *     that rides the existing `ContextPayload.content: string` channel.
 *     The Leader learns the filename, dimensions, and every
 *     annotation's normalized position + note. When Phase 2 lands the
 *     extractor upgrades to return `ContextBlock[]` with a real image
 *     block; the UI here does not change.
 */
import { useCallback, useRef, useState, useEffect } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, CONTEXT_OUT_PORT } from "../graph.ts";
import type { NodeInterfaceContract } from "../graph.ts";
import {
  AnnotationLayer,
  type Annotation,
  type AnnotationTool,
} from "../components/AnnotationLayer.tsx";
import { MarkupToolbar, MARKUP_PALETTE } from "../components/MarkupToolbar.tsx";

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
 * Flatten an ImageNode into the current string-based context channel.
 * Phase 2 replaces this with a block-returning extractor; the shape
 * below is the honest text fallback until then.
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

// ── Helpers ────────────────────────────────────────────

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
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

  const update = useCallback(
    (patch: Partial<ImageNodeData>) => {
      onUpdateData({ ...data, ...patch });
    },
    [data, onUpdateData],
  );

  const loadFile = useCallback(
    async (file: File): Promise<void> => {
      if (!file.type.startsWith("image/")) return;
      setLoading(true);
      try {
        const src = await readFileAsDataURL(file);
        const dims = await loadImageDimensions(src);
        onUpdateData({
          ...data,
          src,
          naturalWidth: dims.width,
          naturalHeight: dims.height,
          filename: file.name,
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

  const tool = data.selectedTool ?? "pin";
  const color = data.defaultColor ?? IMAGE_NODE_DEFAULT_COLOR;
  const selected = data.annotations.find((a) => a.id === data.selectedAnnotationId) ?? null;

  // ── Annotation callbacks ─────────────────────────────
  const addAnnotation = useCallback(
    (a: Annotation) => {
      update({ annotations: [...data.annotations, a] });
    },
    [data.annotations, update],
  );
  const updateAnnotation = useCallback(
    (id: string, patch: Partial<Annotation>) => {
      update({
        annotations: data.annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      });
    },
    [data.annotations, update],
  );
  const deleteAnnotation = useCallback(
    (id: string) => {
      const next = data.annotations
        .filter((a) => a.id !== id)
        // Re-number remaining annotations so order stays 1..N.
        .map((a, i) => ({ ...a, order: i + 1 }));
      const nextSelected =
        data.selectedAnnotationId === id ? null : (data.selectedAnnotationId ?? null);
      update({ annotations: next, selectedAnnotationId: nextSelected });
    },
    [data.annotations, data.selectedAnnotationId, update],
  );
  const setSelected = useCallback(
    (id: string | null) => {
      update({ selectedAnnotationId: id });
    },
    [update],
  );

  return (
    <div
      data-testid="image-node"
      onMouseDown={(e) => e.stopPropagation()}
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
        border: `1px solid ${isSelected ? "color-mix(in srgb, var(--accent) 50%, transparent)" : "var(--border-subtle)"}`,
        overflow: "hidden",
        boxShadow: isSelected ? "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)" : "none",
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "color-mix(in srgb, var(--bg-secondary) 70%, transparent)",
          flexShrink: 0,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            background: "var(--state-active)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accent)",
            fontSize: 10,
          }}
        >
          {"▣"}
        </div>
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

      {/* Image + annotation layer */}
      <div
        style={{
          flex: 1,
          position: "relative",
          background: "var(--bg-primary)",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {data.src ? (
          <>
            <img
              src={data.src}
              alt={data.filename ?? "Pasted image"}
              draggable={false}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
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
            />
          </>
        ) : (
          <EmptyState
            loading={loading}
            reduceMotion={reduceMotion}
            onPick={() => inputRef.current?.click()}
          />
        )}
      </div>

      {/* Hidden file input so the empty state can open a picker */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onFileInputChange}
      />

      {/* Toolbar — only once an image has been loaded */}
      {data.src && (
        <MarkupToolbar
          tool={tool}
          color={color}
          selected={selected}
          annotationCount={data.annotations.length}
          onToolChange={(t) => update({ selectedTool: t })}
          onColorChange={(c) => update({ defaultColor: c })}
          onNoteChange={(id, note) => updateAnnotation(id, { note })}
          onDelete={deleteAnnotation}
        />
      )}
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
      style={{
        position: "absolute",
        inset: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        border: "1.5px dashed color-mix(in srgb, var(--accent) 40%, transparent)",
        borderRadius: 8,
        background: "color-mix(in srgb, var(--accent) 3%, transparent)",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        cursor: loading ? "progress" : "pointer",
        opacity: reduceMotion ? 1 : undefined,
        animation: reduceMotion ? undefined : "imageNodePulse 2.4s ease-in-out infinite",
      }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5-5-9 9" />
      </svg>
      <span style={{ textAlign: "center", lineHeight: 1.5 }}>
        {loading ? "Loading…" : "Drop an image, paste, or click to pick"}
      </span>
    </button>
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
  defaultSize: { width: 480, height: 420 },
  render: ImageNodeRenderer,
  providesContext: true,
  extractContent: extractImageNodeContent,
});
