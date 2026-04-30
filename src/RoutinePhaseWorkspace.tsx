/**
 * RoutinePhaseWorkspace — the "what does this phase do" task surface.
 *
 * Shown when selection.kind === "phase". Edits phase metadata (label, id,
 * description) and presents the phase's steps as an auto-fit grid of tiles.
 * Tiles are clickable (drill into step workspace) and draggable (reorder).
 *
 * The full step editor never opens here — that's the step workspace's job.
 * This screen's role is to plan the *shape* of the phase.
 */
import { useRef, type CSSProperties, type DragEvent } from "react";
import type {
  Routine,
  RoutinePhase,
  RoutineStep,
} from "../shared/routines/types.ts";
import { extractRefs } from "./routine-context-paths.ts";
import {
  cardSt,
  emptyStateSt,
  eyebrowSt,
  fieldErrSt,
  inputSt,
  labelSt,
  refCodeSt,
  refInputSt,
  refLabelSt,
  refRowSt,
  sectionSt,
  subHeaderSt,
  subTitleHintSt,
  subTitleSt,
  subtitleSt,
  titleSt,
  addBtnSt,
  btnBase,
} from "./routine-editor-styles.ts";
import { stepHasError } from "./routine-editor-shared.ts";

interface Props {
  phase: RoutinePhase;
  phaseIdx: number;
  /** Unused at present but kept symmetric with the step workspace's API. */
  draft: Routine;
  errors: Record<string, string>;
  onChangePhase: (
    phaseIdx: number,
    field: keyof RoutinePhase,
    value: unknown,
  ) => void;
  onAddStep: (phaseIdx: number) => void;
  onMoveStep: (phaseIdx: number, from: number, to: number) => void;
  onOpenStep: (phaseIdx: number, stepIdx: number) => void;
  onRemovePhase: (phaseIdx: number) => void;
  totalPhases: number;
}

export function RoutinePhaseWorkspace({
  phase,
  phaseIdx,
  draft: _draft,
  errors,
  onChangePhase,
  onAddStep,
  onMoveStep,
  onOpenStep,
  onRemovePhase,
  totalPhases,
}: Props) {
  const dragSourceRef = useRef<number | null>(null);
  const idErr = errors[`phases.${phaseIdx}.id`];
  const labelErr = errors[`phases.${phaseIdx}.label`];

  const onTileDragStart = (e: DragEvent, stepIdx: number) => {
    dragSourceRef.current = stepIdx;
    e.dataTransfer.effectAllowed = "move";
    e.stopPropagation();
  };
  const onTileDrop = (e: DragEvent, targetIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const src = dragSourceRef.current;
    if (src === null || src === targetIdx) return;
    onMoveStep(phaseIdx, src, targetIdx);
    dragSourceRef.current = null;
  };

  return (
    <section aria-label={`Phase ${phaseIdx + 1}`} style={{ ...sectionSt, gap: 24 }}>
      {/* Header */}
      <header
        style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={eyebrowSt}>
            Phase {phaseIdx + 1} of {totalPhases}
          </span>
          <h2 style={titleSt}>
            <span>{phase.label || phase.id || `Phase ${phaseIdx + 1}`}</span>
          </h2>
          <p style={subtitleSt}>
            Steps inside a phase run in parallel; phases run in declared order.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (
              totalPhases > 1 &&
              confirm(`Remove phase "${phase.label || phase.id}"?`)
            )
              onRemovePhase(phaseIdx);
          }}
          disabled={totalPhases <= 1}
          aria-label={`Remove phase ${phase.label || phaseIdx + 1}`}
          style={{
            ...btnBase,
            color:
              totalPhases <= 1 ? "var(--text-muted)" : "var(--danger-color)",
            background: "transparent",
            cursor: totalPhases <= 1 ? "not-allowed" : "pointer",
          }}
        >
          Remove phase
        </button>
      </header>

      {/* Phase metadata */}
      <div style={cardSt}>
        <div>
          <label style={labelSt}>Label *</label>
          <input
            style={{
              ...inputSt,
              borderColor: labelErr ? "var(--danger-color)" : undefined,
            }}
            value={phase.label}
            onChange={(e) => onChangePhase(phaseIdx, "label", e.target.value)}
            placeholder={`Phase ${phaseIdx + 1}`}
            aria-label={`Phase ${phaseIdx + 1} label`}
          />
          {labelErr && <div style={fieldErrSt}>{labelErr}</div>}
        </div>
        <div style={refRowSt}>
          <span style={refLabelSt}>Phase id</span>
          <code style={refCodeSt}>{phase.id || "…"}</code>
          <input
            style={{
              ...refInputSt,
              borderColor: idErr ? "var(--danger-color)" : undefined,
            }}
            value={phase.id}
            onChange={(e) => onChangePhase(phaseIdx, "id", e.target.value)}
            placeholder="auto"
            aria-label={`Phase ${phaseIdx + 1} id`}
          />
        </div>
        {idErr && <div style={fieldErrSt}>{idErr}</div>}
        <div style={{ marginTop: 12 }}>
          <label style={labelSt}>Description</label>
          <textarea
            style={{
              ...inputSt,
              minHeight: 56,
              resize: "vertical",
              width: "100%",
              boxSizing: "border-box",
            }}
            value={phase.description ?? ""}
            onChange={(e) =>
              onChangePhase(phaseIdx, "description", e.target.value)
            }
            placeholder="What does this phase accomplish?"
            aria-label={`Phase ${phaseIdx + 1} description`}
          />
        </div>
      </div>

      {/* Steps tile grid */}
      <div>
        <div style={subHeaderSt}>
          <h4 style={subTitleSt}>
            Steps · {phase.steps.length}
            <span style={subTitleHintSt}>click a tile to author it</span>
          </h4>
          <button
            type="button"
            onClick={() => onAddStep(phaseIdx)}
            style={addBtnSt}
            aria-label={`Add step to phase ${phaseIdx + 1}`}
          >
            + Add step
          </button>
        </div>
        {phase.steps.length === 0 ? (
          <div style={emptyStateSt}>No steps yet. Add the first one.</div>
        ) : (
          <div style={tileGridSt}>
            {phase.steps.map((step, stepIdx) => (
              <StepTile
                key={step.id || stepIdx}
                step={step}
                stepIdx={stepIdx}
                phaseIdx={phaseIdx}
                hasError={stepHasError(errors, phaseIdx, stepIdx)}
                onOpen={() => onOpenStep(phaseIdx, stepIdx)}
                onDragStart={onTileDragStart}
                onDrop={onTileDrop}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── StepTile ────────────────────────────────────────────────────────────────

interface StepTileProps {
  step: RoutineStep;
  stepIdx: number;
  phaseIdx: number;
  hasError: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent, stepIdx: number) => void;
  onDrop: (e: DragEvent, stepIdx: number) => void;
}

function StepTile({
  step,
  stepIdx,
  hasError,
  onOpen,
  onDragStart,
  onDrop,
}: StepTileProps) {
  const promptPreview = step.routinePrompt.trim();
  const promptShort =
    promptPreview.length > 140
      ? `${promptPreview.slice(0, 140)}…`
      : promptPreview;
  const refCount = countRefs(step);
  return (
    <article
      data-step-tile
      draggable
      onDragStart={(e) => onDragStart(e, stepIdx)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(e, stepIdx)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${step.label || step.id || `step ${stepIdx + 1}`}`}
      style={{
        ...tileSt,
        borderColor: hasError ? "var(--danger-color)" : "var(--border-default)",
      }}
    >
      <header style={tileHeaderSt}>
        <span style={tileOrdinalSt}>{stepIdx + 1}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={tileTitleSt}>
            <span>{step.label || `Step ${stepIdx + 1}`}</span>
          </div>
          <div style={tileSubtitleSt}>{step.id || "—"}</div>
        </div>
      </header>
      <p style={tilePromptSt}>
        {promptShort || (
          <span style={{ color: "var(--danger-color)", fontStyle: "italic" }}>
            prompt empty
          </span>
        )}
      </p>
      <footer style={tileFooterSt}>
        <Tag>
          {step.skillIds.length} skill{step.skillIds.length === 1 ? "" : "s"}
        </Tag>
        <Tag>
          {step.mcpServerIds.length} mcp
        </Tag>
        <Tag tone={refCount > 0 ? "info" : undefined}>
          {refCount} ref{refCount === 1 ? "" : "s"}
        </Tag>
        {hasError && <Tag tone="danger">issue</Tag>}
      </footer>
    </article>
  );
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "info" | "danger" | undefined;
}) {
  const palette: Record<string, { bg: string; color: string }> = {
    info: { bg: "var(--info-bg)", color: "var(--info-color)" },
    danger: { bg: "var(--error-bg)", color: "var(--status-error)" },
  };
  const p = tone ? palette[tone]! : null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 8px",
        borderRadius: 12,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        background: p?.bg ?? "var(--bg-elevated)",
        color: p?.color ?? "var(--text-muted)",
        border: "1px solid transparent",
      }}
    >
      {children}
    </span>
  );
}

function countRefs(step: RoutineStep): number {
  const set = new Set<string>();
  for (const r of extractRefs(step.routinePrompt)) set.add(r.path);
  if (step.systemPrompt) {
    for (const r of extractRefs(step.systemPrompt)) set.add(r.path);
  }
  return set.size;
}

// ── Styles ──────────────────────────────────────────────────────────────────

const tileGridSt: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
  marginTop: 12,
};

const tileSt: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 14,
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 10,
  cursor: "pointer",
  transition: "border-color 0.15s, transform 0.15s, box-shadow 0.15s",
  outline: "none",
};

const tileHeaderSt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const tileOrdinalSt: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  borderRadius: 8,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-default)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  fontWeight: 700,
  flexShrink: 0,
};

const tileTitleSt: CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tileSubtitleSt: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  marginTop: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tilePromptSt: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
  minHeight: 36,
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const tileFooterSt: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: "auto",
};
