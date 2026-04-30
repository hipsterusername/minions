/**
 * RoutineOutlineRail — the routine's structural navigator.
 *
 * Renders a vertical outline (Inputs entry, then a numbered list of phases
 * with step pips) plus an audit panel at the foot. This is the only nav
 * surface for the editor — clicks set the active selection, drag reorders
 * phases. Steps are surfaced as pips to keep the rail dense; their labels
 * are exposed as `aria-label` / `title` for accessibility but not as visible
 * text (visible text lives in the phase workspace tile).
 */
import { useRef, type DragEvent, type CSSProperties } from "react";
import type { Routine } from "../shared/routines/types.ts";
import { auditRoutineRefs } from "./routine-context-paths.ts";
import {
  inputsHaveError,
  phaseHasError,
  stepHasError,
  type Selection,
} from "./routine-editor-shared.ts";

interface Props {
  routine: Routine;
  selection: Selection;
  errors: Record<string, string>;
  onSelect: (next: Selection) => void;
  onAddPhase: () => void;
  onMovePhase: (from: number, to: number) => void;
}

export function RoutineOutlineRail({
  routine,
  selection,
  errors,
  onSelect,
  onAddPhase,
  onMovePhase,
}: Props) {
  const dragSourceRef = useRef<number | null>(null);
  const audit = auditRoutineRefs(routine);

  const onPhaseDragStart = (e: DragEvent, phaseIdx: number) => {
    dragSourceRef.current = phaseIdx;
    e.dataTransfer.effectAllowed = "move";
  };
  const onPhaseDrop = (e: DragEvent, phaseIdx: number) => {
    e.preventDefault();
    const src = dragSourceRef.current;
    if (src === null || src === phaseIdx) return;
    onMovePhase(src, phaseIdx);
    dragSourceRef.current = null;
  };

  const overviewActive = selection.kind === "overview";
  const inputsErr = inputsHaveError(errors, routine.inputs.length);

  return (
    <aside aria-label="Routine outline" style={railSt}>
      {/* Inputs entry */}
      <button
        type="button"
        onClick={() => onSelect({ kind: "overview" })}
        aria-current={overviewActive ? "true" : undefined}
        aria-label="Open overview"
        style={{
          ...railItemSt,
          ...(overviewActive ? railItemActiveSt : null),
          ...(inputsErr ? railItemErrorSt : null),
        }}
      >
        <span style={inputsBadgeSt}>◇</span>
        <span style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
          <span style={railItemTitleSt}>Overview</span>
          <span style={railItemMetaSt}>
            {routine.inputs.length === 0
              ? "no inputs"
              : `${routine.inputs.length} input${routine.inputs.length === 1 ? "" : "s"}`}
          </span>
        </span>
      </button>

      {/* Phases section */}
      <section role="region" aria-label="Phases" style={phasesRegionSt}>
        <div style={railSubHeaderSt}>
          <span style={railSubHeaderLabelSt}>Phases</span>
        </div>
        {routine.phases.map((phase, phaseIdx) => {
          const phaseActive =
            (selection.kind === "phase" || selection.kind === "step") &&
            selection.phaseIdx === phaseIdx;
          const errFlag = phaseHasError(errors, phaseIdx);
          return (
            <div
              key={phase.id || phaseIdx}
              draggable
              onDragStart={(e) => onPhaseDragStart(e, phaseIdx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onPhaseDrop(e, phaseIdx)}
              style={phaseGroupSt}
            >
              <button
                type="button"
                onClick={() => onSelect({ kind: "phase", phaseIdx })}
                aria-current={
                  phaseActive && selection.kind === "phase" ? "true" : undefined
                }
                aria-label={`Open phase ${phase.label || phase.id}`}
                style={{
                  ...railItemSt,
                  ...(phaseActive ? railItemActiveSt : null),
                  ...(errFlag ? railItemErrorSt : null),
                }}
              >
                <span style={phaseOrdinalSt}>{phaseIdx + 1}</span>
                <span style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                  <span style={railItemTitleSt}>
                    {phase.label || phase.id || `Phase ${phaseIdx + 1}`}
                  </span>
                  <span style={railItemMetaSt}>
                    {phase.steps.length} step
                    {phase.steps.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
              <div
                style={pipsRowSt}
                aria-label={`Steps in phase ${phaseIdx + 1}`}
              >
                {phase.steps.map((step, stepIdx) => {
                  const stepActive =
                    selection.kind === "step" &&
                    selection.phaseIdx === phaseIdx &&
                    selection.stepIdx === stepIdx;
                  const stepErr = stepHasError(errors, phaseIdx, stepIdx);
                  return (
                    <button
                      key={step.id || stepIdx}
                      type="button"
                      onClick={() =>
                        onSelect({ kind: "step", phaseIdx, stepIdx })
                      }
                      title={step.label || step.id || `Step ${stepIdx + 1}`}
                      aria-label={`Open ${step.label || step.id || `step ${stepIdx + 1}`}`}
                      aria-current={stepActive ? "true" : undefined}
                      style={{
                        ...pipSt,
                        ...(stepActive ? pipActiveSt : null),
                        ...(stepErr ? pipErrorSt : null),
                      }}
                    >
                      {stepIdx + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAddPhase}
          aria-label="Add phase"
          style={addPhaseBtnSt}
        >
          + Add phase
        </button>
      </section>

      {/* Audit panel */}
      <section aria-label="Validation audit" style={auditPanelSt}>
        <div style={railSubHeaderSt}>
          <span style={railSubHeaderLabelSt}>Audit</span>
        </div>
        <AuditRow
          tone={audit.unknownRefs.length > 0 ? "danger" : "ok"}
          label={`${audit.unknownRefs.length} unresolved ref${audit.unknownRefs.length === 1 ? "" : "s"}`}
        />
        <AuditRow
          tone={audit.unusedInputs.length > 0 ? "warn" : "ok"}
          label={`${audit.unusedInputs.length} unused input${audit.unusedInputs.length === 1 ? "" : "s"}`}
        />
      </section>
    </aside>
  );
}

// ── AuditRow ────────────────────────────────────────────────────────────────

function AuditRow({
  tone,
  label,
}: {
  tone: "ok" | "warn" | "danger";
  label: string;
}) {
  const palette = {
    ok: { bg: "var(--success-bg)", color: "var(--status-success)", glyph: "✓" },
    warn: {
      bg: "var(--warning-bg, var(--muted-bg))",
      color: "var(--status-warning, var(--text-muted))",
      glyph: "!",
    },
    danger: {
      bg: "var(--error-bg)",
      color: "var(--status-error)",
      glyph: "×",
    },
  } as const;
  const p = palette[tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: p.bg,
        color: p.color,
        borderRadius: 6,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>
        {p.glyph}
      </span>
      <span>{label}</span>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const railSt: CSSProperties = {
  width: 240,
  flexShrink: 0,
  borderRight: "1px solid var(--border-default)",
  background: "var(--bg-primary)",
  overflowY: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const railItemSt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "8px 10px",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 8,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  color: "var(--text-primary)",
  transition: "background 0.12s, border-color 0.12s",
};

const railItemActiveSt: CSSProperties = {
  background: "var(--state-active)",
  borderColor: "var(--accent)",
};

const railItemErrorSt: CSSProperties = {
  borderColor: "var(--danger-color)",
};

const railItemTitleSt: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const railItemMetaSt: CSSProperties = {
  display: "block",
  fontSize: 10,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  marginTop: 2,
};

const phasesRegionSt: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const railSubHeaderSt: CSSProperties = {
  padding: "0 4px",
  marginBottom: 2,
};

const railSubHeaderLabelSt: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-muted)",
};

const phaseGroupSt: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const phaseOrdinalSt: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 6,
  background: "var(--accent)",
  color: "white",
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "var(--font-mono)",
  flexShrink: 0,
};

const inputsBadgeSt: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 6,
  background: "rgba(124, 77, 255, 0.18)",
  color: "#a78bfa",
  fontSize: 13,
  fontWeight: 700,
  flexShrink: 0,
};

const pipsRowSt: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  paddingLeft: 36,
  paddingRight: 8,
};

const pipSt: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: "50%",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-default)",
  fontSize: 10,
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: 0,
  transition: "background 0.12s, border-color 0.12s, color 0.12s",
};

const pipActiveSt: CSSProperties = {
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "white",
};

const pipErrorSt: CSSProperties = {
  borderColor: "var(--danger-color)",
  color: "var(--danger-color)",
};

const addPhaseBtnSt: CSSProperties = {
  marginTop: 4,
  padding: "8px 10px",
  background: "transparent",
  border: "1px dashed var(--border-default)",
  borderRadius: 8,
  color: "var(--text-secondary)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  cursor: "pointer",
};

const auditPanelSt: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginTop: "auto",
  paddingTop: 12,
  borderTop: "1px solid var(--border-default)",
};
