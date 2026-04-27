/**
 * RoutineEditor — visual editor for Routine JSON files.
 *
 * Replaces hand-editing `.claude-canvas/routines/<id>.json` files.
 *
 * Two screens:
 *   - **List** (default) — browse all routines for the project, with
 *     New / Edit / Delete actions.
 *   - **Edit** — two-panel layout: left = metadata + inputs + phases tree,
 *     right = selected phase or step form. Live validation via
 *     `safeParseRoutine` + `findDuplicateIds`; Save is disabled while
 *     invalid.
 *
 * Drag-and-drop phase / step reordering uses HTML5 DnD (no new deps).
 * `{{path}}` autocomplete in prompt textareas suggests valid template
 * paths relative to the cursor's phase position.
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { Routine, RoutineInput, RoutinePhase, RoutineStep } from "../shared/routines/types.ts";
import { safeParseRoutine, findDuplicateIds } from "../shared/routines/types.ts";
import { getAllSkills } from "./skills/registry.ts";
import {
  listProjectRoutines,
  saveProjectRoutine,
  deleteProjectRoutine,
  type RoutineListResult,
} from "./api.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface RoutineEditorProps {
  projectId: string;
  onClose: () => void;
}

type Selection =
  | { type: "phase"; phaseIdx: number }
  | { type: "step"; phaseIdx: number; stepIdx: number }
  | null;

interface ValidationResult {
  ok: boolean;
  fieldErrors: Record<string, string>;
  globalErrors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function newStep(phaseIdx: number, stepIdx: number): RoutineStep {
  return {
    id: `step-${phaseIdx + 1}-${stepIdx + 1}`,
    label: `Step ${stepIdx + 1}`,
    agent: "leader" as const,
    routinePrompt: "",
    skillIds: [],
    skillValues: {},
    mcpServerIds: [],
  };
}

function newPhase(phaseIdx: number): RoutinePhase {
  return {
    id: `phase-${phaseIdx + 1}`,
    label: `Phase ${phaseIdx + 1}`,
    description: "",
    steps: [newStep(phaseIdx, 0)],
  };
}

function newRoutine(): Routine {
  return {
    id: "",
    name: "New Routine",
    description: "",
    version: 1,
    inputs: [],
    phases: [newPhase(0)],
    failurePolicy: "fail-fast",
  };
}

function validateDraft(draft: Routine): ValidationResult {
  const parsed = safeParseRoutine(draft);
  if (!parsed.ok) {
    const fieldErrors: Record<string, string> = {};
    const globalErrors: string[] = [];
    for (const { path, message } of parsed.errors) {
      if (path) {
        fieldErrors[path] = message;
      } else {
        globalErrors.push(message);
      }
    }
    return { ok: false, fieldErrors, globalErrors };
  }
  const dups = findDuplicateIds(parsed.routine);
  if (dups.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const dup of dups) {
      fieldErrors[dup] = `Duplicate id: ${dup}`;
    }
    return { ok: false, fieldErrors, globalErrors: dups.map((d) => `Duplicate id: ${d}`) };
  }
  return { ok: true, fieldErrors: {}, globalErrors: [] };
}

function priorStepIds(phases: RoutinePhase[], phaseIdx: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < phaseIdx; i++) {
    for (const step of phases[i]?.steps ?? []) {
      ids.push(step.id);
    }
  }
  return ids;
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

interface AutocompleteInfo {
  suggestions: string[];
  partial: string;
  startPos: number;
}

function getAutocompleteInfo(
  text: string,
  cursor: number,
  inputNames: string[],
  priorIds: string[],
): AutocompleteInfo | null {
  const before = text.slice(0, cursor);
  const lastOpen = before.lastIndexOf("{{");
  if (lastOpen < 0) return null;
  const afterOpen = before.slice(lastOpen + 2);
  if (afterOpen.includes("}}")) return null;

  const partial = afterOpen;
  const candidates = [
    ...inputNames.map((n) => `inputs.${n}`),
    "handoff.brief",
    ...priorIds.map((id) => `handoff.steps.${id}.summary`),
    ...priorIds.map((id) => `handoff.facts.${id}.`),
  ];
  const suggestions = partial
    ? candidates.filter((c) => c.toLowerCase().startsWith(partial.toLowerCase()))
    : candidates;

  return { suggestions, partial, startPos: lastOpen };
}

// ── PromptTextarea ───────────────────────────────────────────────────────────

interface PromptTextareaProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputNames: string[];
  priorIds: string[];
  minHeight?: number;
  "aria-label"?: string;
}

function PromptTextarea({
  value,
  onChange,
  placeholder,
  inputNames,
  priorIds,
  minHeight = 100,
  "aria-label": ariaLabel,
}: PromptTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [acInfo, setAcInfo] = useState<AutocompleteInfo | null>(null);

  const recompute = useCallback(() => {
    const el = ref.current;
    if (!el) { setAcInfo(null); return; }
    const info = getAutocompleteInfo(el.value, el.selectionStart, inputNames, priorIds);
    setAcInfo(info && info.suggestions.length > 0 ? info : null);
  }, [inputNames, priorIds]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    recompute();
  };

  const handleKeyUp = () => recompute();

  const handleMouseUp = () => recompute();

  const applySuggestion = (suggestion: string) => {
    const el = ref.current;
    if (!el || !acInfo) return;
    const before = el.value.slice(0, acInfo.startPos);
    const after = el.value.slice(el.selectionStart);
    const inserted = `{{${suggestion}}}`;
    const next = before + inserted + after;
    onChange(next);
    setAcInfo(null);
    el.focus();
    const pos = before.length + inserted.length;
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") setAcInfo(null);
  };

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyUp={handleKeyUp}
        onKeyDown={handleKeyDown}
        onMouseUp={handleMouseUp}
        placeholder={placeholder}
        aria-label={ariaLabel}
        style={{
          ...inputSt,
          fontFamily: "var(--font-mono)",
          minHeight,
          resize: "vertical",
          lineHeight: 1.5,
          width: "100%",
          boxSizing: "border-box",
        }}
      />
      {acInfo && (
        <ul
          role="listbox"
          style={{
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
            maxHeight: 160,
            overflowY: "auto",
            minWidth: 260,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}
        >
          {acInfo.suggestions.slice(0, 12).map((s) => (
            <li
              key={s}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
              style={{
                padding: "5px 12px",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--accent)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--state-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              {`{{${s}}}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── SkillChipPicker ──────────────────────────────────────────────────────────

interface SkillChipPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
}

function SkillChipPicker({ value, onChange }: SkillChipPickerProps) {
  const skills = getAllSkills();
  if (skills.length === 0) {
    return (
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
        No skills available
      </span>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {skills.map((s) => {
        const selected = value.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={selected}
            onClick={() =>
              onChange(
                selected ? value.filter((id) => id !== s.id) : [...value, s.id],
              )
            }
            style={{
              padding: "3px 10px",
              borderRadius: 12,
              border: `1px solid ${selected ? "var(--accent)" : "var(--border-default)"}`,
              background: selected ? "var(--accent)" : "var(--bg-primary)",
              color: selected ? "white" : "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              transition: "all 0.15s",
            }}
          >
            {s.icon ? `${s.icon} ` : ""}{s.name}
          </button>
        );
      })}
    </div>
  );
}

// ── InputRow ─────────────────────────────────────────────────────────────────

interface InputRowProps {
  input: RoutineInput;
  idx: number;
  onChange: (idx: number, field: keyof RoutineInput, value: unknown) => void;
  onRemove: (idx: number) => void;
  error?: string;
}

function InputRow({ input, idx, onChange, onRemove, error }: InputRowProps) {
  return (
    <div
      style={{
        padding: 10,
        background: "var(--bg-primary)",
        border: `1px solid ${error ? "var(--danger-color)" : "var(--border-default)"}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 80px auto", gap: 6, alignItems: "end" }}>
        <div>
          <label style={labelSt}>Name *</label>
          <input
            style={inputSt}
            value={input.name}
            onChange={(e) => onChange(idx, "name", e.target.value)}
            placeholder="input-name"
            aria-label={`Input ${idx + 1} name`}
          />
        </div>
        <div>
          <label style={labelSt}>Type</label>
          <select
            style={{ ...inputSt, cursor: "pointer" }}
            value={input.type}
            onChange={(e) => onChange(idx, "type", e.target.value)}
            aria-label={`Input ${idx + 1} type`}
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </select>
        </div>
        <div>
          <label style={labelSt}>Required</label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={input.required}
              onChange={(e) => onChange(idx, "required", e.target.checked)}
              aria-label={`Input ${idx + 1} required`}
            />
            <span style={{ fontSize: 12 }}>Yes</span>
          </label>
        </div>
        <button
          type="button"
          onClick={() => onRemove(idx)}
          aria-label={`Remove input ${input.name || idx + 1}`}
          style={{ ...btnBase, color: "var(--danger-color)", alignSelf: "end" }}
        >
          ×
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
        <div>
          <label style={labelSt}>Label *</label>
          <input
            style={inputSt}
            value={input.label}
            onChange={(e) => onChange(idx, "label", e.target.value)}
            placeholder="Human-readable label"
            aria-label={`Input ${idx + 1} label`}
          />
        </div>
        <div>
          <label style={labelSt}>Default value</label>
          <input
            style={inputSt}
            value={input.defaultValue !== undefined ? String(input.defaultValue) : ""}
            onChange={(e) => onChange(idx, "defaultValue", e.target.value || undefined)}
            placeholder="Optional default"
            aria-label={`Input ${idx + 1} default value`}
          />
        </div>
      </div>
      {error && (
        <div style={{ color: "var(--danger-color)", fontSize: 11, marginTop: 4 }}>{error}</div>
      )}
    </div>
  );
}

// ── MetadataSection ──────────────────────────────────────────────────────────

interface MetadataSectionProps {
  draft: Routine;
  onChange: (field: "id" | "name" | "description", value: string) => void;
  errors: Record<string, string>;
}

function MetadataSection({ draft, onChange, errors }: MetadataSectionProps) {
  return (
    <section aria-label="Routine metadata" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={sectionHeadingSt}>Metadata</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={labelSt}>Name *</label>
          <input
            style={{ ...inputSt, borderColor: errors.name ? "var(--danger-color)" : undefined }}
            value={draft.name}
            onChange={(e) => onChange("name", e.target.value)}
            placeholder="My Routine"
            aria-label="Routine name"
          />
          {errors.name && <div style={fieldErrSt}>{errors.name}</div>}
        </div>
        <div>
          <label style={labelSt}>ID *</label>
          <input
            style={{ ...inputSt, borderColor: errors.id ? "var(--danger-color)" : undefined }}
            value={draft.id}
            onChange={(e) => onChange("id", e.target.value)}
            placeholder="my-routine"
            aria-label="Routine ID"
          />
          {errors.id && <div style={fieldErrSt}>{errors.id}</div>}
        </div>
      </div>
      <div>
        <label style={labelSt}>Description</label>
        <input
          style={inputSt}
          value={draft.description ?? ""}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder="What does this routine do?"
          aria-label="Routine description"
        />
      </div>
    </section>
  );
}

// ── InputsSection ────────────────────────────────────────────────────────────

interface InputsSectionProps {
  inputs: RoutineInput[];
  onChange: (inputs: RoutineInput[]) => void;
  errors: Record<string, string>;
}

function InputsSection({ inputs, onChange, errors }: InputsSectionProps) {
  const addInput = () => {
    onChange([
      ...inputs,
      { name: "", type: "string" as const, label: "", required: true },
    ]);
  };

  const updateInput = (idx: number, field: keyof RoutineInput, value: unknown) => {
    const next = inputs.map((inp, i) =>
      i === idx ? { ...inp, [field]: value } : inp,
    );
    onChange(next);
  };

  const removeInput = (idx: number) => {
    onChange(inputs.filter((_, i) => i !== idx));
  };

  return (
    <section aria-label="Routine inputs" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ ...sectionHeadingSt, margin: 0 }}>Inputs</h3>
        <button type="button" onClick={addInput} style={addBtnSt} aria-label="Add input">
          + Add input
        </button>
      </div>
      {inputs.map((inp, idx) => (
        <InputRow
          key={idx}
          input={inp}
          idx={idx}
          onChange={updateInput}
          onRemove={removeInput}
          error={errors[`inputs.${idx}.name`] ?? errors[`inputs.${idx}.label`]}
        />
      ))}
      {inputs.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          No inputs yet — routines can be triggered without inputs too.
        </div>
      )}
    </section>
  );
}

// ── PhasesTree ────────────────────────────────────────────────────────────────

interface PhasesTreeProps {
  phases: RoutinePhase[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onChange: (phases: RoutinePhase[]) => void;
  errors: Record<string, string>;
}

function PhasesTree({ phases, selection, onSelect, onChange, errors }: PhasesTreeProps) {
  const dragPhaseIdx = useRef<number | null>(null);
  const dragStepKey = useRef<{ phaseIdx: number; stepIdx: number } | null>(null);

  const addPhase = () => {
    const next = [...phases, newPhase(phases.length)];
    onChange(next);
    onSelect({ type: "phase", phaseIdx: next.length - 1 });
  };

  const removePhase = (phaseIdx: number) => {
    const next = phases.filter((_, i) => i !== phaseIdx);
    onChange(next);
    onSelect(null);
  };

  const addStep = (phaseIdx: number) => {
    const phase = phases[phaseIdx]!;
    const next = phases.map((p, i) =>
      i === phaseIdx
        ? { ...p, steps: [...p.steps, newStep(phaseIdx, p.steps.length)] }
        : p,
    );
    onChange(next);
    onSelect({ type: "step", phaseIdx, stepIdx: phase.steps.length });
  };

  const removeStep = (phaseIdx: number, stepIdx: number) => {
    const next = phases.map((p, i) =>
      i === phaseIdx ? { ...p, steps: p.steps.filter((_, si) => si !== stepIdx) } : p,
    );
    onChange(next);
    onSelect(null);
  };

  const onPhaseDragStart = (e: DragEvent, idx: number) => {
    dragPhaseIdx.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };

  const onPhaseDrop = (e: DragEvent, targetIdx: number) => {
    e.preventDefault();
    const src = dragPhaseIdx.current;
    if (src === null || src === targetIdx) return;
    const next = [...phases];
    const [moved] = next.splice(src, 1);
    next.splice(targetIdx, 0, moved!);
    onChange(next);
    dragPhaseIdx.current = null;
  };

  const onStepDragStart = (e: DragEvent, phaseIdx: number, stepIdx: number) => {
    dragStepKey.current = { phaseIdx, stepIdx };
    e.dataTransfer.effectAllowed = "move";
    e.stopPropagation();
  };

  const onStepDrop = (e: DragEvent, phaseIdx: number, targetStepIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const src = dragStepKey.current;
    if (!src || src.phaseIdx !== phaseIdx || src.stepIdx === targetStepIdx) return;
    const next = phases.map((p, i) => {
      if (i !== phaseIdx) return p;
      const steps = [...p.steps];
      const [moved] = steps.splice(src.stepIdx, 1);
      steps.splice(targetStepIdx, 0, moved!);
      return { ...p, steps };
    });
    onChange(next);
    dragStepKey.current = null;
  };

  return (
    <section aria-label="Phases" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ ...sectionHeadingSt, margin: 0 }}>Phases</h3>
        <button type="button" onClick={addPhase} style={addBtnSt} aria-label="Add phase">
          + Add phase
        </button>
      </div>
      {phases.length === 0 && (
        <div style={{ color: "var(--danger-color)", fontSize: 12 }}>
          At least one phase is required.
        </div>
      )}
      {phases.map((phase, phaseIdx) => {
        const phaseSelected = selection?.type === "phase" && selection.phaseIdx === phaseIdx;
        const phaseHasError = !!errors[`phases.${phaseIdx}.id`] || !!errors[`phases.${phaseIdx}.label`];
        return (
          <div
            key={phaseIdx}
            draggable
            onDragStart={(e) => onPhaseDragStart(e, phaseIdx)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onPhaseDrop(e, phaseIdx)}
            style={{
              border: `1px solid ${phaseHasError ? "var(--danger-color)" : phaseSelected ? "var(--accent)" : "var(--border-default)"}`,
              borderRadius: 6,
              background: "var(--bg-primary)",
              userSelect: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                cursor: "pointer",
                background: phaseSelected ? "var(--state-hover)" : "transparent",
              }}
              onClick={() => onSelect({ type: "phase", phaseIdx })}
            >
              <span style={{ color: "var(--text-muted)", fontSize: 14, cursor: "grab" }}>⠿</span>
              <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {phase.label || `Phase ${phaseIdx + 1}`}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {phase.id || "—"}
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removePhase(phaseIdx); }}
                aria-label={`Remove phase ${phase.label || phaseIdx + 1}`}
                style={{ ...btnBase, color: "var(--danger-color)", fontSize: 14, padding: "0 4px" }}
              >
                ×
              </button>
            </div>
            <div style={{ paddingLeft: 20, paddingBottom: 6 }}>
              {phase.steps.map((step, stepIdx) => {
                const stepSelected =
                  selection?.type === "step" &&
                  selection.phaseIdx === phaseIdx &&
                  selection.stepIdx === stepIdx;
                const stepHasError =
                  !!errors[`phases.${phaseIdx}.steps.${stepIdx}.id`] ||
                  !!errors[`phases.${phaseIdx}.steps.${stepIdx}.routinePrompt`];
                return (
                  <div
                    key={stepIdx}
                    draggable
                    onDragStart={(e) => onStepDragStart(e, phaseIdx, stepIdx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onStepDrop(e, phaseIdx, stepIdx)}
                    onClick={() => onSelect({ type: "step", phaseIdx, stepIdx })}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 6px 4px 0",
                      cursor: "pointer",
                      borderRadius: 4,
                      background: stepSelected ? "var(--state-hover)" : "transparent",
                      borderLeft: `2px solid ${stepHasError ? "var(--danger-color)" : stepSelected ? "var(--accent)" : "transparent"}`,
                      paddingLeft: 6,
                    }}
                  >
                    <span style={{ color: "var(--text-muted)", fontSize: 12, cursor: "grab" }}>⠿</span>
                    <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {step.label || `Step ${stepIdx + 1}`}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {step.id || "—"}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeStep(phaseIdx, stepIdx); }}
                      aria-label={`Remove step ${step.label || stepIdx + 1}`}
                      style={{ ...btnBase, color: "var(--danger-color)", fontSize: 12, padding: "0 3px" }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => addStep(phaseIdx)}
                style={{ ...addBtnSt, fontSize: 11, marginTop: 4 }}
                aria-label={`Add step to phase ${phase.label || phaseIdx + 1}`}
              >
                + Add step
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ── PhaseEditForm ─────────────────────────────────────────────────────────────

interface PhaseEditFormProps {
  phase: RoutinePhase;
  phaseIdx: number;
  errors: Record<string, string>;
  onChange: (phaseIdx: number, field: keyof RoutinePhase, value: unknown) => void;
}

function PhaseEditForm({ phase, phaseIdx, errors, onChange }: PhaseEditFormProps) {
  const idErr = errors[`phases.${phaseIdx}.id`];
  const labelErr = errors[`phases.${phaseIdx}.label`];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        Edit Phase {phaseIdx + 1}
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={labelSt}>Phase ID *</label>
          <input
            style={{ ...inputSt, borderColor: idErr ? "var(--danger-color)" : undefined }}
            value={phase.id}
            onChange={(e) => onChange(phaseIdx, "id", e.target.value)}
            placeholder="phase-1"
            aria-label={`Phase ${phaseIdx + 1} id`}
          />
          {idErr && <div style={fieldErrSt}>{idErr}</div>}
        </div>
        <div>
          <label style={labelSt}>Label *</label>
          <input
            style={{ ...inputSt, borderColor: labelErr ? "var(--danger-color)" : undefined }}
            value={phase.label}
            onChange={(e) => onChange(phaseIdx, "label", e.target.value)}
            placeholder="Phase 1"
            aria-label={`Phase ${phaseIdx + 1} label`}
          />
          {labelErr && <div style={fieldErrSt}>{labelErr}</div>}
        </div>
      </div>
      <div>
        <label style={labelSt}>Description</label>
        <textarea
          style={{ ...inputSt, minHeight: 60, resize: "vertical", width: "100%", boxSizing: "border-box" }}
          value={phase.description ?? ""}
          onChange={(e) => onChange(phaseIdx, "description", e.target.value)}
          placeholder="Describe what this phase accomplishes…"
          aria-label={`Phase ${phaseIdx + 1} description`}
        />
      </div>
    </div>
  );
}

// ── StepEditForm ──────────────────────────────────────────────────────────────

interface StepEditFormProps {
  step: RoutineStep;
  phaseIdx: number;
  stepIdx: number;
  draft: Routine;
  errors: Record<string, string>;
  onChange: (phaseIdx: number, stepIdx: number, field: keyof RoutineStep, value: unknown) => void;
}

function StepEditForm({ step, phaseIdx, stepIdx, draft, errors, onChange }: StepEditFormProps) {
  const idErr = errors[`phases.${phaseIdx}.steps.${stepIdx}.id`];
  const labelErr = errors[`phases.${phaseIdx}.steps.${stepIdx}.label`];
  const promptErr = errors[`phases.${phaseIdx}.steps.${stepIdx}.routinePrompt`];
  const inputNames = draft.inputs.map((i) => i.name).filter(Boolean);
  const prevIds = priorStepIds(draft.phases, phaseIdx);

  const update = (field: keyof RoutineStep, value: unknown) =>
    onChange(phaseIdx, stepIdx, field, value);

  const addMcpServer = () => {
    const id = prompt("MCP server id:");
    if (id?.trim()) update("mcpServerIds", [...step.mcpServerIds, id.trim()]);
  };

  const removeMcpServer = (id: string) => {
    update("mcpServerIds", step.mcpServerIds.filter((s) => s !== id));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        Edit Step {stepIdx + 1} in Phase {phaseIdx + 1}
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={labelSt}>Step ID *</label>
          <input
            style={{ ...inputSt, borderColor: idErr ? "var(--danger-color)" : undefined }}
            value={step.id}
            onChange={(e) => update("id", e.target.value)}
            placeholder="step-1"
            aria-label={`Step ${stepIdx + 1} id`}
          />
          {idErr && <div style={fieldErrSt}>{idErr}</div>}
        </div>
        <div>
          <label style={labelSt}>Label *</label>
          <input
            style={{ ...inputSt, borderColor: labelErr ? "var(--danger-color)" : undefined }}
            value={step.label}
            onChange={(e) => update("label", e.target.value)}
            placeholder="Step 1"
            aria-label={`Step ${stepIdx + 1} label`}
          />
          {labelErr && <div style={fieldErrSt}>{labelErr}</div>}
        </div>
      </div>
      <div>
        <label style={labelSt}>Agent</label>
        <input style={{ ...inputSt, color: "var(--text-muted)" }} value="leader" readOnly aria-label="Agent (always leader in v1)" />
      </div>
      <div>
        <label style={labelSt}>Routine prompt * (supports {"{{path}}"})</label>
        <PromptTextarea
          value={step.routinePrompt}
          onChange={(v) => update("routinePrompt", v)}
          placeholder={"Investigate {{inputs.topic}} and summarise findings."}
          inputNames={inputNames}
          priorIds={prevIds}
          minHeight={100}
          aria-label={`Step ${stepIdx + 1} routine prompt`}
        />
        {promptErr && <div style={fieldErrSt}>{promptErr}</div>}
      </div>
      <div>
        <label style={labelSt}>System prompt override (optional, supports {"{{path}}"})</label>
        <PromptTextarea
          value={step.systemPrompt ?? ""}
          onChange={(v) => update("systemPrompt", v || undefined)}
          placeholder="Leave blank to use the default leader prompt."
          inputNames={inputNames}
          priorIds={prevIds}
          minHeight={60}
          aria-label={`Step ${stepIdx + 1} system prompt`}
        />
      </div>
      <div>
        <label style={labelSt}>Skills</label>
        <SkillChipPicker
          value={step.skillIds}
          onChange={(ids) => update("skillIds", ids)}
        />
      </div>
      <div>
        <label style={labelSt}>MCP server IDs</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {step.mcpServerIds.map((id) => (
            <span
              key={id}
              style={{
                padding: "3px 8px 3px 10px",
                borderRadius: 12,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {id}
              <button
                type="button"
                onClick={() => removeMcpServer(id)}
                aria-label={`Remove MCP server ${id}`}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14, padding: 0, lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={addMcpServer} style={addBtnSt} aria-label="Add MCP server id">
            + Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RightPanel ────────────────────────────────────────────────────────────────

interface RightPanelProps {
  draft: Routine;
  selection: Selection;
  errors: Record<string, string>;
  onChangePhase: (phaseIdx: number, field: keyof RoutinePhase, value: unknown) => void;
  onChangeStep: (phaseIdx: number, stepIdx: number, field: keyof RoutineStep, value: unknown) => void;
}

function RightPanel({ draft, selection, errors, onChangePhase, onChangeStep }: RightPanelProps) {
  if (!selection) {
    return (
      <div style={{ color: "var(--text-muted)", padding: 20, fontSize: 13 }}>
        Select a phase or step on the left to edit it.
      </div>
    );
  }
  if (selection.type === "phase") {
    const phase = draft.phases[selection.phaseIdx];
    if (!phase) return null;
    return (
      <PhaseEditForm
        phase={phase}
        phaseIdx={selection.phaseIdx}
        errors={errors}
        onChange={onChangePhase}
      />
    );
  }
  const phase = draft.phases[selection.phaseIdx];
  const step = phase?.steps[selection.stepIdx];
  if (!phase || !step) return null;
  return (
    <StepEditForm
      step={step}
      phaseIdx={selection.phaseIdx}
      stepIdx={selection.stepIdx}
      draft={draft}
      errors={errors}
      onChange={onChangeStep}
    />
  );
}

// ── RoutineEditView ───────────────────────────────────────────────────────────

interface RoutineEditViewProps {
  draft: Routine;
  selection: Selection;
  saving: boolean;
  saveError: string | null;
  onClose: () => void;
  onSave: () => void;
  onChange: (draft: Routine) => void;
  onSelect: (s: Selection) => void;
}

function RoutineEditView({
  draft, selection, saving, saveError, onClose, onSave, onChange, onSelect,
}: RoutineEditViewProps) {
  const validation = validateDraft(draft);

  const setField = (field: "id" | "name" | "description", value: string) => {
    const next = { ...draft, [field]: value };
    if (field === "name" && !draft.id) next.id = generateId(value);
    onChange(next);
  };

  const setInputs = (inputs: RoutineInput[]) => onChange({ ...draft, inputs });

  const setPhases = (phases: RoutinePhase[]) => onChange({ ...draft, phases });

  const changePhase = (phaseIdx: number, field: keyof RoutinePhase, value: unknown) => {
    const phases = draft.phases.map((p, i) =>
      i === phaseIdx ? { ...p, [field]: value } : p,
    );
    onChange({ ...draft, phases });
  };

  const changeStep = (
    phaseIdx: number,
    stepIdx: number,
    field: keyof RoutineStep,
    value: unknown,
  ) => {
    const phases = draft.phases.map((p, pi) => {
      if (pi !== phaseIdx) return p;
      const steps = p.steps.map((s, si) =>
        si === stepIdx ? { ...s, [field]: value } : s,
      );
      return { ...p, steps };
    });
    onChange({ ...draft, phases });
  };

  return (
    <>
      <div style={editorHeaderSt}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {draft.name || "New Routine"}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onClose} style={{ ...btnBase, background: "var(--bg-primary)", color: "var(--text-secondary)" }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!validation.ok || saving}
            aria-disabled={!validation.ok || saving}
            title={!validation.ok ? "Fix validation errors before saving" : undefined}
            style={{
              ...btnBase,
              background: validation.ok && !saving ? "var(--accent)" : "var(--bg-elevated)",
              color: validation.ok && !saving ? "white" : "var(--text-muted)",
              border: `1px solid ${validation.ok ? "var(--accent)" : "var(--border-default)"}`,
              cursor: validation.ok && !saving ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
          >
            {saving ? "Saving…" : "Save & close"}
          </button>
        </div>
      </div>

      {(saveError || validation.globalErrors.length > 0) && (
        <div
          role="alert"
          style={{ padding: "8px 16px", background: "var(--error-bg)", color: "var(--danger-color)", fontSize: 12 }}
        >
          {saveError ?? validation.globalErrors.join(" · ")}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left panel */}
        <div style={{ width: 280, borderRight: "1px solid var(--border-default)", overflowY: "auto", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 20, flexShrink: 0 }}>
          <MetadataSection draft={draft} onChange={setField} errors={validation.fieldErrors} />
          <InputsSection inputs={draft.inputs} onChange={setInputs} errors={validation.fieldErrors} />
          <PhasesTree
            phases={draft.phases}
            selection={selection}
            onSelect={onSelect}
            onChange={setPhases}
            errors={validation.fieldErrors}
          />
        </div>
        {/* Right panel */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          <RightPanel
            draft={draft}
            selection={selection}
            errors={validation.fieldErrors}
            onChangePhase={changePhase}
            onChangeStep={changeStep}
          />
        </div>
      </div>
    </>
  );
}

// ── RoutineListView ───────────────────────────────────────────────────────────

interface RoutineListViewProps {
  routines: Routine[];
  invalid: RoutineListResult["invalid"];
  loading: boolean;
  onEdit: (r: Routine) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function RoutineListView({ routines, invalid, loading, onEdit, onNew, onDelete }: RoutineListViewProps) {
  return (
    <>
      <div style={editorHeaderSt}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Routines</span>
        <button type="button" onClick={onNew} style={{ ...btnBase, background: "var(--accent)", color: "white", border: "1px solid var(--accent)", fontWeight: 600 }}>
          + New routine
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {loading && (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        )}
        {!loading && routines.length === 0 && invalid.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            No routines yet. Click "+ New routine" to create one.
          </div>
        )}
        {routines.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 12px",
              background: "var(--bg-primary)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
              {r.description && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {r.description}
                </div>
              )}
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                {r.id} · {r.phases.length} phase{r.phases.length !== 1 ? "s" : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onEdit(r)}
              aria-label={`Edit routine ${r.name}`}
              style={{ ...btnBase, background: "var(--bg-secondary)" }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete routine "${r.name}"?`)) onDelete(r.id);
              }}
              aria-label={`Delete routine ${r.name}`}
              style={{ ...btnBase, color: "var(--danger-color)", background: "none", border: "1px solid var(--danger-color)" }}
            >
              Delete
            </button>
          </div>
        ))}
        {invalid.map((inv) => (
          <div
            key={inv.file}
            style={{
              padding: "10px 12px",
              background: "var(--error-bg)",
              border: "1px solid var(--danger-color)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--danger-color)",
            }}
          >
            <strong>{inv.file}</strong> — invalid:{" "}
            {inv.errors.map((e) => e.message).join(", ")}
          </div>
        ))}
      </div>
    </>
  );
}

// ── RoutineEditor (main export) ───────────────────────────────────────────────

export function RoutineEditor({ projectId, onClose }: RoutineEditorProps) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [invalid, setInvalid] = useState<RoutineListResult["invalid"]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listProjectRoutines(projectId).then((result) => {
      if (cancelled) return;
      setRoutines(result.routines);
      setInvalid(result.invalid);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  const openNew = useCallback(() => {
    setEditing(newRoutine());
    setSelection(null);
    setSaveError(null);
  }, []);

  const openEdit = useCallback((r: Routine) => {
    setEditing({ ...r });
    setSelection(null);
    setSaveError(null);
  }, []);

  const handleDelete = useCallback(async (routineId: string) => {
    await deleteProjectRoutine(projectId, routineId);
    setRoutines((prev) => prev.filter((r) => r.id !== routineId));
  }, [projectId]);

  const handleSave = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveProjectRoutine(projectId, editing);
      setRoutines((prev) => {
        const idx = prev.findIndex((r) => r.id === saved.id);
        return idx >= 0 ? prev.map((r, i) => (i === idx ? saved : r)) : [...prev, saved];
      });
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [editing, projectId]);

  const handleClose = useCallback(() => {
    if (editing) {
      setEditing(null);
    } else {
      onClose();
    }
  }, [editing, onClose]);

  return (
    <div
      style={overlaySt}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="Routine editor"
    >
      <div
        style={modalSt}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close routine editor"
          style={{ position: "absolute", top: 12, right: 12, background: "none", border: "none", color: "var(--text-muted)", fontSize: 22, cursor: "pointer", zIndex: 1 }}
        >
          ×
        </button>

        {editing ? (
          <RoutineEditView
            draft={editing}
            selection={selection}
            saving={saving}
            saveError={saveError}
            onClose={() => setEditing(null)}
            onSave={() => void handleSave()}
            onChange={setEditing}
            onSelect={setSelection}
          />
        ) : (
          <RoutineListView
            routines={routines}
            invalid={invalid}
            loading={loading}
            onEdit={openEdit}
            onNew={openNew}
            onDelete={(id) => void handleDelete(id)}
          />
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const overlaySt: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-bg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const modalSt: React.CSSProperties = {
  position: "relative",
  width: "min(900px, 96vw)",
  height: "min(700px, 92vh)",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  fontFamily: "var(--font-sans)",
  color: "var(--text-primary)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const editorHeaderSt: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 48px 12px 16px",
  borderBottom: "1px solid var(--border-default)",
  background: "var(--bg-primary)",
  flexShrink: 0,
};

const labelSt: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--text-secondary)",
  marginBottom: 3,
  fontFamily: "var(--font-sans)",
};

const inputSt: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 5,
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const btnBase: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
};

const addBtnSt: React.CSSProperties = {
  ...btnBase,
  background: "none",
  color: "var(--text-secondary)",
  border: "1px dashed var(--border-default)",
  fontSize: 12,
};

const sectionHeadingSt: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  margin: 0,
};

const fieldErrSt: React.CSSProperties = {
  color: "var(--danger-color)",
  fontSize: 11,
  marginTop: 2,
};
