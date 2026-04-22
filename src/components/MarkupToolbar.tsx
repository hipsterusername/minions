/**
 * Markup toolbar for image/visual nodes.
 *
 * Owns the tool picker (select / pin / rect), a small fixed color
 * palette, and a note editor that appears when an annotation is
 * selected. Deliberately dumb — all state lives on the node, this is
 * purely presentational.
 */
import type { AnnotationTool, Annotation } from "./AnnotationLayer.tsx";

/**
 * Fixed palette keyed to the theme's accent tokens. Kept small on
 * purpose — the point is to pick *something* that stands out on the
 * underlying image, not to match a brand.
 */
export const MARKUP_PALETTE: ReadonlyArray<{ label: string; color: string }> = [
  { label: "Accent", color: "var(--accent)" },
  { label: "Red", color: "#ef4444" },
  { label: "Amber", color: "#f59e0b" },
  { label: "Green", color: "#10b981" },
  { label: "Blue", color: "#3b82f6" },
  { label: "Violet", color: "#8b5cf6" },
];

export interface MarkupToolbarProps {
  tool: AnnotationTool;
  color: string;
  selected: Annotation | null;
  annotationCount: number;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
}

export function MarkupToolbar({
  tool,
  color,
  selected,
  annotationCount,
  onToolChange,
  onColorChange,
  onNoteChange,
  onDelete,
  disabled = false,
}: MarkupToolbarProps): React.JSX.Element {
  return (
    <div
      data-testid="markup-toolbar"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "6px 8px",
        background: "color-mix(in srgb, var(--bg-secondary) 92%, transparent)",
        borderTop: "1px solid var(--border-subtle)",
        backdropFilter: "blur(8px)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <ToolButton
          label="Select"
          active={tool === "select"}
          disabled={disabled}
          onClick={() => onToolChange("select")}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 3l8 3.5-3 1.5-1.5 3.5z" strokeLinejoin="round" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Pin"
          active={tool === "pin"}
          disabled={disabled}
          onClick={() => onToolChange("pin")}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="6" r="3.5" />
            <path d="M8 9.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Rect"
          active={tool === "rect"}
          disabled={disabled}
          onClick={() => onToolChange("rect")}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="2.5" y="3.5" width="11" height="9" rx="1" strokeDasharray="2 1.2" />
          </svg>
        </ToolButton>

        <div style={{ width: 1, height: 16, background: "var(--border-subtle)", margin: "0 2px" }} />

        <div style={{ display: "flex", gap: 4 }} role="radiogroup" aria-label="Annotation color">
          {MARKUP_PALETTE.map((swatch) => (
            <button
              key={swatch.color}
              type="button"
              role="radio"
              aria-checked={swatch.color === color}
              aria-label={swatch.label}
              disabled={disabled}
              onClick={() => onColorChange(swatch.color)}
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                border: swatch.color === color
                  ? "2px solid var(--text-primary)"
                  : "1px solid var(--border-subtle)",
                background: swatch.color,
                cursor: disabled ? "not-allowed" : "pointer",
                padding: 0,
              }}
            />
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <span style={{
          fontSize: 10,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}>
          {annotationCount === 0 ? "no marks" : `${annotationCount} mark${annotationCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {selected && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}>
            {selected.kind} {selected.order}
          </span>
          <input
            type="text"
            value={selected.note}
            placeholder="Add a note…"
            onChange={(e) => onNoteChange(selected.id, e.target.value)}
            aria-label="Annotation note"
            style={{
              flex: 1,
              background: "var(--bg-primary)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-primary)",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              padding: "3px 6px",
              borderRadius: 4,
              outline: "none",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => onDelete(selected.id)}
            aria-label="Delete annotation"
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-muted)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              padding: "3px 6px",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Internal ──────────────────────────────────────────────

interface ToolButtonProps {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ToolButton({ label, active, disabled, onClick, children }: ToolButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 22,
        padding: 0,
        background: active ? "var(--state-active)" : "transparent",
        border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 50%, transparent)" : "var(--border-subtle)"}`,
        borderRadius: 4,
        color: active ? "var(--accent)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
      }}
    >
      {children}
    </button>
  );
}
