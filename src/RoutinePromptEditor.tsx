/**
 * RoutinePromptEditor — visual prompt-authoring surface.
 *
 * Three coordinated affordances:
 *   1. **Textarea** with autocomplete on `{{` and drop-target wiring.
 *   2. **Live preview** — renders the current prompt with `{{tokens}}`
 *      replaced by colour-coded chips so the author can see what's static
 *      vs. what's a context reference, and at a glance spot unresolved refs.
 *   3. **Context Palette** sidebar — click/drag any entry to insert it
 *      at the cursor.
 *
 * The editor is dumb: it renders, fires onChange, and exposes an
 * `insertAtCursor` method the palette and drop handler use. All routine-
 * shape knowledge lives in the parent (and in `routine-context-paths.ts`).
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  buildPaletteSections,
  extractRefs,
  tallyUsage,
} from "./routine-context-paths.ts";
import {
  RoutineContextPalette,
  paletteStyleFor,
} from "./RoutineContextPalette.tsx";
import type { Routine } from "../shared/routines/types.ts";

interface Props {
  /** Current value. */
  value: string;
  onChange: (next: string) => void;
  /** Routine being edited — needed to resolve available paths. */
  routine: Routine;
  /** Phase index in the routine; controls what handoff context is in scope. */
  phaseIdx: number;
  /** Min visual height for the textarea. */
  minHeight?: number;
  placeholder?: string;
  "aria-label"?: string;
  /** Hide the palette sidebar (for the system-prompt slot which uses the same engine). */
  showPalette?: boolean;
  /** Hide the live preview (compact mode for short fields). */
  showPreview?: boolean;
}

export function RoutinePromptEditor({
  value,
  onChange,
  routine,
  phaseIdx,
  minHeight = 120,
  placeholder,
  "aria-label": ariaLabel,
  showPalette = true,
  showPreview = true,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [acOpen, setAcOpen] = useState(false);
  const [acPartial, setAcPartial] = useState("");

  const sections = useMemo(
    () => buildPaletteSections(routine, phaseIdx),
    [routine, phaseIdx],
  );
  const usage = useMemo(() => tallyUsage(value), [value]);

  // Flat list of valid paths for the {{ autocomplete dropdown.
  const allPaths = useMemo(
    () => sections.flatMap((s) => s.entries.map((e) => e.path)),
    [sections],
  );

  const insertAtCursor = useCallback(
    (path: string) => {
      const el = taRef.current;
      const insertion = `{{${path}}}`;
      if (!el) {
        onChange(value + insertion);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = value.slice(0, start) + insertion + value.slice(end);
      onChange(next);
      // Restore cursor *after* the inserted token next paint.
      const pos = start + insertion.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );

  // ── Autocomplete ──────────────────────────────────────────
  const recomputeAc = useCallback(() => {
    const el = taRef.current;
    if (!el) {
      setAcOpen(false);
      return;
    }
    const before = value.slice(0, el.selectionStart);
    const lastOpen = before.lastIndexOf("{{");
    if (lastOpen < 0) {
      setAcOpen(false);
      return;
    }
    const partial = before.slice(lastOpen + 2);
    if (partial.includes("}}") || partial.includes("\n")) {
      setAcOpen(false);
      return;
    }
    setAcPartial(partial);
    setAcOpen(true);
  }, [value]);

  const acSuggestions = useMemo(() => {
    if (!acOpen) return [];
    const q = acPartial.toLowerCase();
    return allPaths
      .filter((p) => (q ? p.toLowerCase().startsWith(q) : true))
      .slice(0, 10);
  }, [acOpen, acPartial, allPaths]);

  const applyAc = useCallback(
    (path: string) => {
      const el = taRef.current;
      if (!el) {
        insertAtCursor(path);
        return;
      }
      const before = value.slice(0, el.selectionStart);
      const lastOpen = before.lastIndexOf("{{");
      if (lastOpen < 0) {
        insertAtCursor(path);
        return;
      }
      // Replace the in-progress {{partial with a complete {{path}}.
      const after = value.slice(el.selectionStart);
      const next = value.slice(0, lastOpen) + `{{${path}}}` + after;
      onChange(next);
      setAcOpen(false);
      const pos = lastOpen + `{{${path}}}`.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange, insertAtCursor],
  );

  // ── Drop target ──────────────────────────────────────────
  const handleDrop = useCallback(
    (e: DragEvent<HTMLTextAreaElement>) => {
      const raw = e.dataTransfer.getData("application/x-routine-ref");
      if (!raw) return; // let the browser's default text drop run.
      e.preventDefault();
      try {
        const parsed = JSON.parse(raw) as { path?: string };
        if (parsed.path) insertAtCursor(parsed.path);
      } catch {
        /* ignore malformed payloads */
      }
    },
    [insertAtCursor],
  );

  // ── Keyboard ─────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") setAcOpen(false);
    },
    [],
  );

  // ── Render ───────────────────────────────────────────────
  return (
    <div style={layoutSt(showPalette)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ position: "relative" }}>
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              recomputeAc();
            }}
            onKeyUp={recomputeAc}
            onMouseUp={recomputeAc}
            onKeyDown={handleKeyDown}
            onDrop={handleDrop}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-routine-ref")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }
            }}
            placeholder={placeholder}
            aria-label={ariaLabel}
            data-routine-prompt
            style={{ ...textareaSt, minHeight }}
          />
          {acOpen && acSuggestions.length > 0 && (
            <ul role="listbox" style={acListSt}>
              {acSuggestions.map((p) => (
                <li
                  key={p}
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyAc(p);
                  }}
                  style={acItemSt}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      "var(--state-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      "transparent";
                  }}
                >{`{{${p}}}`}</li>
              ))}
            </ul>
          )}
        </div>
        {showPreview && <PromptPreview text={value} />}
      </div>
      {showPalette && (
        <RoutineContextPalette
          sections={sections}
          usage={usage}
          onInsert={insertAtCursor}
          emptyHint={
            phaseIdx === 0
              ? "First phase has no upstream context. Add inputs above to surface them here."
              : "No upstream phase yet."
          }
        />
      )}
    </div>
  );
}

// ── PromptPreview ─────────────────────────────────────────────────────────

/**
 * Renders the prompt with `{{tokens}}` replaced by colored chips inline so
 * the author can see at a glance which parts are static text and which are
 * dynamic context references. Unresolved refs (kind="unknown") are shown
 * with a red warning chip.
 */
export function PromptPreview({ text }: { text: string }) {
  const segments = useMemo(() => splitForPreview(text), [text]);
  if (text.trim().length === 0) {
    return (
      <div style={emptyPreviewSt} aria-label="Prompt preview">
        Preview appears here as you type.
      </div>
    );
  }
  return (
    <div
      aria-label="Prompt preview"
      style={previewSt}
      data-routine-prompt-preview
    >
      <div style={previewHeaderSt}>Preview</div>
      <div style={previewBodySt}>
        {segments.map((seg, i) =>
          seg.kind === "text" ? (
            <span key={i}>{seg.value}</span>
          ) : (
            <PreviewChip
              key={i}
              path={seg.path}
              kind={seg.refKind}
            />
          ),
        )}
      </div>
    </div>
  );
}

function PreviewChip({
  path,
  kind,
}: {
  path: string;
  kind: ReturnType<typeof extractRefs>[number]["kind"];
}) {
  const style = paletteStyleFor(kind);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        margin: "0 2px",
        borderRadius: 4,
        background: style.bg,
        border: `1px solid ${style.border}`,
        color: style.color,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        verticalAlign: "baseline",
      }}
      title={kind === "unknown" ? `Unresolved reference: ${path}` : path}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>
        {style.glyph}
      </span>
      {path}
    </span>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

interface PreviewSegment {
  kind: "text" | "ref";
  value: string;
  path: string;
  refKind: ReturnType<typeof extractRefs>[number]["kind"];
}

/**
 * Slice the prompt into alternating text + ref segments. Pure — colocated
 * in this module so the visual preview never drifts from extractRefs.
 */
function splitForPreview(text: string): PreviewSegment[] {
  const out: PreviewSegment[] = [];
  const refs = extractRefs(text);
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) {
      out.push({
        kind: "text",
        value: text.slice(cursor, ref.start),
        path: "",
        refKind: "unknown",
      });
    }
    out.push({
      kind: "ref",
      value: text.slice(ref.start, ref.end),
      path: ref.path,
      refKind: ref.kind,
    });
    cursor = ref.end;
  }
  if (cursor < text.length) {
    out.push({
      kind: "text",
      value: text.slice(cursor),
      path: "",
      refKind: "unknown",
    });
  }
  return out;
}

// ── Styles ─────────────────────────────────────────────────────────────────

function layoutSt(showPalette: boolean): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: showPalette ? "minmax(0, 1fr) 240px" : "1fr",
    gap: 12,
    alignItems: "start",
  };
}

const textareaSt: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  lineHeight: 1.5,
  outline: "none",
  resize: "vertical",
  boxSizing: "border-box",
};

const acListSt: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  zIndex: 200,
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  margin: 0,
  padding: "4px 0",
  listStyle: "none",
  maxHeight: 180,
  overflowY: "auto",
  minWidth: 280,
  boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
};

const acItemSt: React.CSSProperties = {
  padding: "5px 12px",
  cursor: "pointer",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--accent)",
};

const previewSt: React.CSSProperties = {
  border: "1px dashed var(--border-default)",
  borderRadius: 6,
  background: "var(--bg-elevated)",
  overflow: "hidden",
};

const previewHeaderSt: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  padding: "5px 10px",
  borderBottom: "1px solid var(--border-default)",
  background: "var(--bg-secondary)",
};

const previewBodySt: React.CSSProperties = {
  padding: "8px 10px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  lineHeight: 1.65,
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const emptyPreviewSt: React.CSSProperties = {
  ...previewSt,
  ...previewBodySt,
  color: "var(--text-muted)",
  fontStyle: "italic",
};
