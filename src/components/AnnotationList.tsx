/**
 * Compact roster of annotations on an ImageNode (or any future host
 * using AnnotationLayer). Gives users a browsable inventory of every
 * mark with its note preview, so reviewing "what have I flagged" no
 * longer requires click-each-one on the image itself.
 *
 * Intentionally presentational — all state (selection, notes, colours)
 * lives on the node and flows in via props. A click on a row selects;
 * a click on the delete glyph removes. Rows are sorted by `order` so
 * the sequence reads 1→N, regardless of the array order on the node.
 */
import type { Annotation } from "./AnnotationLayer.tsx";

export interface AnnotationListProps {
  annotations: ReadonlyArray<Annotation>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** Hard cap so the list doesn't push the image off-screen on dense nodes. */
  maxHeight?: number;
}

const ROW_HEIGHT = 26;

export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
  onDelete,
  maxHeight = 140,
}: AnnotationListProps): React.JSX.Element | null {
  if (annotations.length === 0) return null;
  const sorted = [...annotations].sort((a, b) => a.order - b.order);
  return (
    <div
      data-testid="annotation-list"
      data-no-drag
      role="list"
      aria-label="Annotations"
      style={{
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid var(--border-default)",
        background: "color-mix(in srgb, var(--bg-secondary) 65%, transparent)",
        maxHeight,
        overflowY: "auto",
        fontFamily: "var(--font-sans)",
      }}
    >
      {sorted.map((a) => {
        const isSelected = a.id === selectedId;
        const preview = a.note.trim() || (a.kind === "pin" ? "(unnamed pin)" : "(unnamed rect)");
        return (
          <div
            key={a.id}
            role="listitem"
            data-testid={`annotation-row-${a.id}`}
            aria-selected={isSelected}
            onClick={() => onSelect(a.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(a.id);
              } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                onDelete(a.id);
              }
            }}
            tabIndex={0}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 8px",
              minHeight: ROW_HEIGHT,
              cursor: "pointer",
              background: isSelected
                ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                : "transparent",
              borderLeft: isSelected
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                (e.currentTarget as HTMLDivElement).style.background =
                  "color-mix(in srgb, var(--text-primary) 4%, transparent)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isSelected) {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }
            }}
          >
            {/* Numbered colour swatch — encodes kind + colour + order in one glyph. */}
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: a.kind === "pin" ? 9 : 3,
                background: a.color,
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "var(--font-mono)",
                flexShrink: 0,
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)",
              }}
            >
              {a.order}
            </span>
            <span
              style={{
                fontSize: 11,
                color: isSelected ? "var(--text-primary)" : "var(--text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
                fontStyle: a.note.trim() ? "normal" : "italic",
              }}
              title={preview}
            >
              {preview}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(a.id);
              }}
              aria-label={`Delete ${a.kind} ${a.order}`}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: 1,
                padding: "2px 4px",
                cursor: "pointer",
                borderRadius: 3,
                opacity: 0.7,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
                (e.currentTarget as HTMLButtonElement).style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                (e.currentTarget as HTMLButtonElement).style.opacity = "0.7";
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
