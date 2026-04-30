/**
 * RoutineContextPalette — sidebar of context references available to a step.
 *
 * Heart of the "context management" UX. The author sees, at a glance, every
 * symbolic reference they can use in this step's prompts — grouped by source
 * (Inputs, the immediately previous phase) and colour-coded by kind. Clicking
 * a chip inserts `{{path}}` at the caller's cursor; dragging drops it
 * anywhere inside a `<textarea data-routine-prompt>` host.
 *
 * Companion to PromptPreview which renders the *consumption* of these refs
 * inline. Together they make the data flow between phases legible.
 *
 * Pure presentation. All data comes from `buildPaletteSections` and the
 * caller's `usage` map; the palette neither parses prompts nor mutates state.
 */
import { useMemo } from "react";
import type {
  PaletteEntry,
  PaletteSection,
  RefKind,
  RefUsage,
} from "./routine-context-paths.ts";

interface Props {
  sections: PaletteSection[];
  /** Path → number of times referenced in the current prompt, for badges. */
  usage: RefUsage;
  /** Insert `{{path}}` at the caller's tracked cursor position. */
  onInsert: (path: string) => void;
  /** Optional empty-state hint shown when no sections exist. */
  emptyHint?: string;
}

/** Visual identity per kind — colour, glyph, screen-reader label. */
const KIND_STYLE: Record<
  RefKind,
  { color: string; bg: string; border: string; glyph: string; aria: string }
> = {
  input: {
    color: "#7c4dff",
    bg: "rgba(124, 77, 255, 0.12)",
    border: "rgba(124, 77, 255, 0.45)",
    glyph: "◇",
    aria: "user input",
  },
  brief: {
    color: "#0ea5e9",
    bg: "rgba(14, 165, 233, 0.12)",
    border: "rgba(14, 165, 233, 0.45)",
    glyph: "❡",
    aria: "phase brief",
  },
  summary: {
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.12)",
    border: "rgba(16, 185, 129, 0.45)",
    glyph: "≡",
    aria: "step summary",
  },
  outcome: {
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.14)",
    border: "rgba(245, 158, 11, 0.5)",
    glyph: "✓",
    aria: "step outcome",
  },
  outputs: {
    color: "#06b6d4",
    bg: "rgba(6, 182, 212, 0.12)",
    border: "rgba(6, 182, 212, 0.45)",
    glyph: "{}",
    aria: "step outputs",
  },
  facts: {
    color: "#a855f7",
    bg: "rgba(168, 85, 247, 0.12)",
    border: "rgba(168, 85, 247, 0.45)",
    glyph: "✦",
    aria: "shared fact",
  },
  unknown: {
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.5)",
    glyph: "?",
    aria: "unknown reference",
  },
};

/** Get the visual identity for a kind — tested by `extractRefs` consumers. */
export function paletteStyleFor(kind: RefKind) {
  return KIND_STYLE[kind];
}

export function RoutineContextPalette({
  sections,
  usage,
  onInsert,
  emptyHint,
}: Props) {
  if (sections.length === 0) {
    return (
      <div
        aria-label="Context palette"
        style={{
          ...wrapSt,
          color: "var(--text-muted)",
          fontSize: 12,
          padding: 12,
          fontStyle: "italic",
        }}
      >
        {emptyHint ?? "No context available yet."}
      </div>
    );
  }

  return (
    <aside
      aria-label="Context palette"
      style={wrapSt}
      data-routine-context-palette
    >
      <div style={headerSt}>
        <span>Context</span>
        <span style={hintSt}>click or drag</span>
      </div>
      <div style={listSt}>
        {sections.map((section) => (
          <Section
            key={section.key}
            section={section}
            usage={usage}
            onInsert={onInsert}
          />
        ))}
      </div>
    </aside>
  );
}

function Section({
  section,
  usage,
  onInsert,
}: {
  section: PaletteSection;
  usage: RefUsage;
  onInsert: (path: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <h4 style={sectionHeadingSt}>{section.title}</h4>
      <div style={chipRowSt}>
        {section.entries.map((entry) => (
          <Chip
            key={entry.path}
            entry={entry}
            count={usage.get(entry.path) ?? 0}
            onInsert={onInsert}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({
  entry,
  count,
  onInsert,
}: {
  entry: PaletteEntry;
  count: number;
  onInsert: (path: string) => void;
}) {
  const style = useMemo(() => paletteStyleFor(entry.kind), [entry.kind]);
  const used = count > 0;
  return (
    <button
      type="button"
      role="option"
      aria-selected={used}
      title={`{{${entry.path}}}${used ? `\nUsed ${count}× in this prompt.` : ""}`}
      data-palette-path={entry.path}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", `{{${entry.path}}}`);
        e.dataTransfer.setData(
          "application/x-routine-ref",
          JSON.stringify({ path: entry.path, kind: entry.kind }),
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onInsert(entry.path)}
      style={{
        ...chipSt,
        background: style.bg,
        border: `1px solid ${style.border}`,
        color: style.color,
        outline: used ? `1.5px solid ${style.color}` : "none",
        outlineOffset: used ? 1 : 0,
      }}
    >
      <span aria-hidden style={glyphSt}>
        {style.glyph}
      </span>
      <span style={{ flex: 1, textAlign: "left" }}>{entry.label}</span>
      {used && (
        <span aria-label={`used ${count} times`} style={badgeSt(style.color)}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const wrapSt: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  background: "var(--bg-primary)",
  minWidth: 200,
  maxWidth: 260,
  overflow: "hidden",
};

const headerSt: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 10px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--border-default)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const hintSt: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 500,
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--text-muted)",
  fontStyle: "italic",
};

const listSt: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 10,
  overflowY: "auto",
  maxHeight: 320,
};

const sectionHeadingSt: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  margin: 0,
  paddingLeft: 2,
};

const chipRowSt: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const chipSt: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 8px",
  borderRadius: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  cursor: "grab",
  textAlign: "left",
  width: "100%",
  transition: "transform 0.1s ease, box-shadow 0.15s ease",
};

const glyphSt: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1,
  width: 14,
  textAlign: "center",
};

function badgeSt(color: string): React.CSSProperties {
  return {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 700,
    minWidth: 16,
    height: 16,
    padding: "0 5px",
    borderRadius: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: color,
    color: "white",
  };
}
