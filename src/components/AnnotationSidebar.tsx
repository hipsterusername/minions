/**
 * AnnotationSidebar — the vertical control + inventory column that
 * lives beside an annotatable image. Owns every markup-editing
 * affordance in one stable surface:
 *
 *   1. Tool row          (pin / rect)
 *   2. Colour palette    (fixed 6-swatch grid)
 *   3. Note editor       (only when a mark is selected)
 *   4. Annotation list   (scrollable, flex-filled)
 *   5. Footer            (count + two-click Clear)
 *
 * The sidebar has a fixed pixel width. The image area next to it is
 * the one that flexes — so adding marks never squeezes the image
 * vertically, and a long list simply scrolls within the sidebar.
 *
 * Destructive "Clear all" is two-step: first click arms, second fires,
 * and the armed state disarms on blur, annotation-count change, or a
 * 3.5s timeout — so a stray click can't erase a batch of markup.
 */
import { useEffect, useRef, useState } from "react";
import type { Annotation, AnnotationTool } from "./AnnotationLayer.tsx";
import { AnnotationList } from "./AnnotationList.tsx";
import { MARKUP_PALETTE } from "./markup-palette.ts";

export interface AnnotationSidebarProps {
  tool: AnnotationTool;
  color: string;
  selected: Annotation | null;
  annotations: ReadonlyArray<Annotation>;
  onToolChange: (tool: AnnotationTool) => void;
  /**
   * Palette click. The host is expected to route this to the *selected*
   * annotation when one exists (category recolouring) and fall back to
   * setting the default colour for future marks otherwise.
   */
  onColorChange: (color: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll?: () => void;
  /** Fixed pixel width. Default tuned to comfortably fit tools+palette. */
  width?: number;
  disabled?: boolean;
}

const CLEAR_ARM_TIMEOUT_MS = 3500;
const DEFAULT_WIDTH = 184;

export function AnnotationSidebar({
  tool,
  color,
  selected,
  annotations,
  onToolChange,
  onColorChange,
  onNoteChange,
  onSelect,
  onDelete,
  onClearAll,
  width = DEFAULT_WIDTH,
  disabled = false,
}: AnnotationSidebarProps): React.JSX.Element {
  const annotationCount = annotations.length;

  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (!clearArmed) return;
    const id = window.setTimeout(() => setClearArmed(false), CLEAR_ARM_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [clearArmed]);
  // Any change in the annotation set resets the confirmation. Adding or
  // removing a mark is a new intent.
  useEffect(() => {
    setClearArmed(false);
  }, [annotationCount]);

  // Auto-focus the note editor whenever a different mark becomes selected.
  // Placing a pin/rect selects it as the last step of the gesture, so this
  // puts the user directly in the note field — no hunt-and-click.
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!selected) return;
    const el = noteRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      // Some environments reject setSelectionRange; focus alone is the win.
    }
  }, [selected?.id]);

  return (
    <aside
      data-testid="annotation-sidebar"
      data-no-drag
      aria-label="Annotation controls"
      style={{
        flex: `0 0 ${width}px`,
        width,
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in srgb, var(--bg-secondary) 70%, transparent)",
        borderLeft: "1px solid var(--border-default)",
        minHeight: 0,
      }}
    >
      {/* 1. Tools — segmented control. Just two: pin or rect. Click an
          existing mark to select/edit it (drag, resize) regardless of
          which create-tool is active. */}
      <div
        role="group"
        aria-label="Annotation tool"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 2,
          padding: 4,
          margin: "8px 10px",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
        }}
      >
        <ToolButton
          label="Pin"
          active={tool === "pin"}
          disabled={disabled}
          onClick={() => onToolChange("pin")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="8" cy="6" r="3" fill="currentColor" />
            <path d="M8 9.2v4.4" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Rect"
          active={tool === "rect"}
          disabled={disabled}
          onClick={() => onToolChange("rect")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" strokeDasharray="2 1.4" />
          </svg>
        </ToolButton>
      </div>

      <div
        style={{
          padding: "10px 10px 12px",
          borderBottom: "1px solid var(--border-default)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <SidebarLabel>{selected ? "Mark colour" : "Next colour"}</SidebarLabel>
          {selected && (
            <span style={{
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              opacity: 0.7,
              letterSpacing: "0.04em",
            }}>
              #{selected.order}
            </span>
          )}
        </div>
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 5, marginTop: 6 }}
          role="radiogroup"
          aria-label={selected ? `Color for ${selected.kind} ${selected.order}` : "Annotation color"}
        >
          {MARKUP_PALETTE.map((swatch) => {
            const isActive = selected
              ? swatch.color === selected.color
              : swatch.color === color;
            return (
              <button
                key={swatch.color}
                type="button"
                role="radio"
                aria-checked={isActive}
                aria-label={swatch.label}
                disabled={disabled}
                onClick={() => onColorChange(swatch.color)}
                style={{
                  aspectRatio: "1 / 1",
                  minHeight: 20,
                  borderRadius: 5,
                  border: "1px solid var(--border-default)",
                  background: swatch.color,
                  cursor: disabled ? "not-allowed" : "pointer",
                  padding: 0,
                  position: "relative",
                  outline: isActive
                    ? "2px solid var(--text-primary)"
                    : "none",
                  outlineOffset: 1,
                  transition: "transform 0.1s ease",
                  transform: isActive ? "scale(1.04)" : "scale(1)",
                }}
              />
            );
          })}
        </div>
      </div>

      {selected && (
        <div
          style={{
            padding: "10px",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            background: "color-mix(in srgb, var(--accent) 4%, transparent)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: selected.kind === "pin" ? 9 : 3,
                background: selected.color,
                color: "#fff",
                fontSize: 9,
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)",
              }}
            >
              {selected.order}
            </span>
            <SidebarLabel>{selected.kind === "pin" ? "Pin" : "Region"}</SidebarLabel>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => onDelete(selected.id)}
              aria-label="Delete annotation"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "transparent",
                border: "1px solid var(--border-default)",
                color: "var(--text-muted)",
                fontSize: 9,
                fontFamily: "var(--font-mono)",
                padding: "2px 6px",
                borderRadius: 4,
                cursor: "pointer",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                transition: "color 0.15s, border-color 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  "color-mix(in srgb, #ef4444 60%, transparent)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)";
              }}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 8.5h4.8L11 5" />
              </svg>
              Delete
            </button>
          </div>
          <textarea
            ref={noteRef}
            value={selected.note}
            placeholder="Add a note for the agent…"
            rows={3}
            onChange={(e) => onNoteChange(selected.id, e.target.value)}
            aria-label="Annotation note"
            style={{
              background: "var(--bg-primary)",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              padding: "7px 8px",
              borderRadius: 5,
              outline: "none",
              resize: "vertical",
              minHeight: 62,
              lineHeight: 1.45,
              transition: "border-color 0.15s, box-shadow 0.15s",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor =
                "color-mix(in srgb, var(--accent) 60%, transparent)";
              e.currentTarget.style.boxShadow =
                "0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border-default)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "8px 10px 4px" }}>
          <SidebarLabel>Annotations</SidebarLabel>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {annotationCount === 0 ? (
            <div
              data-testid="annotation-list-empty"
              style={{
                padding: "8px 10px",
                fontSize: 11,
                fontFamily: "var(--font-sans)",
                color: "var(--text-muted)",
                fontStyle: "italic",
              }}
            >
              Drop a pin or drag a rect on the image to get started.
            </div>
          ) : (
            <AnnotationList
              annotations={annotations}
              selectedId={selected?.id ?? null}
              onSelect={onSelect}
              onDelete={onDelete}
              /* The outer container owns the scroll — let the list grow. */
              maxHeight={9999}
            />
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderTop: "1px solid var(--border-default)",
          background: "color-mix(in srgb, var(--bg-secondary) 50%, transparent)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {annotationCount > 0 && (
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 16,
                height: 14,
                padding: "0 4px",
                borderRadius: 3,
                background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                color: "var(--accent)",
                fontSize: 9,
                fontWeight: 700,
              }}
            >
              {annotationCount}
            </span>
          )}
          {annotationCount === 0
            ? "no marks"
            : `${annotationCount} mark${annotationCount === 1 ? "" : "s"}`}
        </span>
        <div style={{ flex: 1 }} />
        {onClearAll && annotationCount > 0 && (
          <button
            type="button"
            onClick={() => {
              if (disabled) return;
              if (!clearArmed) {
                setClearArmed(true);
                return;
              }
              setClearArmed(false);
              onClearAll();
            }}
            onBlur={() => setClearArmed(false)}
            disabled={disabled}
            aria-label={clearArmed ? "Confirm clear all annotations" : "Clear all annotations"}
            aria-pressed={clearArmed}
            title={clearArmed ? "Click again to confirm — cannot be undone" : "Clear all — does not affect the image"}
            style={{
              background: clearArmed ? "color-mix(in srgb, #ef4444 18%, transparent)" : "transparent",
              border: `1px solid ${clearArmed ? "#ef4444" : "var(--border-default)"}`,
              color: clearArmed ? "#ef4444" : "var(--text-muted)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              padding: "3px 8px",
              borderRadius: 4,
              cursor: disabled ? "not-allowed" : "pointer",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
            }}
          >
            {clearArmed ? "Confirm?" : "Clear"}
          </button>
        )}
      </div>
    </aside>
  );
}

// ── Internal ──────────────────────────────────────────────

function SidebarLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 9,
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {children}
    </span>
  );
}

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
      aria-pressed={active}
      aria-label={label}
      title={label}
      style={{
        flex: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 26,
        padding: "0 4px",
        background: active
          ? "color-mix(in srgb, var(--accent) 18%, var(--bg-surface))"
          : "transparent",
        border: "none",
        borderRadius: 4,
        color: active ? "var(--accent)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: active ? 700 : 500,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        transition: "background 0.15s, color 0.15s",
        boxShadow: active
          ? "0 1px 0 color-mix(in srgb, var(--accent) 18%, transparent)"
          : "none",
      }}
    >
      {children}
      <span aria-hidden style={{ fontSize: 9 }}>{label}</span>
    </button>
  );
}
