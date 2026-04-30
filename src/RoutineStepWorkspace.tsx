/**
 * RoutineStepWorkspace — the "author this step" task surface.
 *
 * Shown when selection.kind === "step". Full-pane editor for one step's
 * label / id / prompts / skills / MCP servers. Includes a breadcrumb back
 * link to its parent phase.
 */
import type { Routine, RoutineStep } from "../shared/routines/types.ts";
import { getAllSkills } from "./skills/registry.ts";
import { RoutinePromptEditor } from "./RoutinePromptEditor.tsx";
import {
  cardSt,
  eyebrowSt,
  fieldErrSt,
  inputSt,
  labelSt,
  refCodeSt,
  refInputSt,
  refLabelSt,
  refRowSt,
  sectionSt,
  subTitleSt,
  subtitleSt,
  titleSt,
  addBtnSt,
  btnBase,
} from "./routine-editor-styles.ts";

interface Props {
  step: RoutineStep;
  phaseIdx: number;
  stepIdx: number;
  draft: Routine;
  errors: Record<string, string>;
  onChange: (
    phaseIdx: number,
    stepIdx: number,
    field: keyof RoutineStep,
    value: unknown,
  ) => void;
  onBack: () => void;
  onRemove: () => void;
}

export function RoutineStepWorkspace({
  step,
  phaseIdx,
  stepIdx,
  draft,
  errors,
  onChange,
  onBack,
  onRemove,
}: Props) {
  const idErr = errors[`phases.${phaseIdx}.steps.${stepIdx}.id`];
  const labelErr = errors[`phases.${phaseIdx}.steps.${stepIdx}.label`];
  const promptErr =
    errors[`phases.${phaseIdx}.steps.${stepIdx}.routinePrompt`];

  const phase = draft.phases[phaseIdx];

  const update = (field: keyof RoutineStep, value: unknown) =>
    onChange(phaseIdx, stepIdx, field, value);

  const addMcp = () => {
    const id = prompt("MCP server id:");
    if (id?.trim()) update("mcpServerIds", [...step.mcpServerIds, id.trim()]);
  };
  const removeMcp = (id: string) =>
    update(
      "mcpServerIds",
      step.mcpServerIds.filter((s) => s !== id),
    );

  return (
    <section
      aria-label={`Step ${stepIdx + 1} of phase ${phaseIdx + 1}`}
      style={{ ...sectionSt, gap: 20 }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to phase"
          style={backLinkSt}
        >
          ← back to {phase?.label || `phase ${phaseIdx + 1}`}
        </button>
        <span style={eyebrowSt}>
          Phase {phaseIdx + 1} · Step {stepIdx + 1}
        </span>
        <h2 style={titleSt}>{step.label || `Step ${stepIdx + 1}`}</h2>
        <p style={subtitleSt}>
          Authoring surface — define this step's prompt, skills, and external
          integrations.
        </p>
      </header>

      <div style={cardSt}>
        <div>
          <label style={labelSt}>Label *</label>
          <input
            style={{
              ...inputSt,
              borderColor: labelErr ? "var(--danger-color)" : undefined,
            }}
            value={step.label}
            onChange={(e) => update("label", e.target.value)}
            placeholder={`Step ${stepIdx + 1}`}
            aria-label={`Step ${stepIdx + 1} label`}
          />
          {labelErr && <div style={fieldErrSt}>{labelErr}</div>}
        </div>
        <div style={refRowSt}>
          <span style={refLabelSt}>Step id</span>
          <code style={refCodeSt}>{step.id || "…"}</code>
          <input
            style={{
              ...refInputSt,
              borderColor: idErr ? "var(--danger-color)" : undefined,
            }}
            value={step.id}
            onChange={(e) => update("id", e.target.value)}
            placeholder="auto"
            aria-label={`Step ${stepIdx + 1} id`}
          />
        </div>
        {idErr && <div style={fieldErrSt}>{idErr}</div>}
      </div>

      <div style={cardSt}>
        <h4 style={{ ...subTitleSt, marginBottom: 8 }}>
          Routine prompt *
        </h4>
        <RoutinePromptEditor
          value={step.routinePrompt}
          onChange={(v) => update("routinePrompt", v)}
          routine={draft}
          phaseIdx={phaseIdx}
          placeholder={"Investigate {{inputs.topic}} and summarise findings."}
          minHeight={140}
          aria-label={`Step ${stepIdx + 1} routine prompt`}
        />
        {promptErr && <div style={fieldErrSt}>{promptErr}</div>}
      </div>

      <details style={{ ...cardSt, padding: 12 }}>
        <summary
          style={{
            cursor: "pointer",
            color: "var(--text-secondary)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          System prompt override (optional)
        </summary>
        <div style={{ marginTop: 10 }}>
          <RoutinePromptEditor
            value={step.systemPrompt ?? ""}
            onChange={(v) => update("systemPrompt", v || undefined)}
            routine={draft}
            phaseIdx={phaseIdx}
            placeholder="Leave blank to use the default leader prompt."
            minHeight={60}
            showPalette={false}
            showPreview={false}
            aria-label={`Step ${stepIdx + 1} system prompt`}
          />
        </div>
      </details>

      <div style={cardSt}>
        <h4 style={{ ...subTitleSt, marginBottom: 8 }}>Skills</h4>
        <SkillChipPicker
          value={step.skillIds}
          onChange={(ids) => update("skillIds", ids)}
        />
      </div>

      <div style={cardSt}>
        <h4 style={{ ...subTitleSt, marginBottom: 8 }}>MCP server IDs</h4>
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
                onClick={() => removeMcp(id)}
                aria-label={`Remove MCP server ${id}`}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  fontSize: 14,
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={addMcp}
            style={addBtnSt}
            aria-label="Add MCP server id"
          >
            + Add
          </button>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Remove step "${step.label || step.id}"?`)) onRemove();
          }}
          aria-label={`Remove step ${step.label || stepIdx + 1}`}
          style={{
            ...btnBase,
            color: "var(--danger-color)",
            background: "transparent",
            borderColor: "var(--danger-color)",
          }}
        >
          Remove step
        </button>
      </div>
    </section>
  );
}

// ── SkillChipPicker ─────────────────────────────────────────────────────────

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
                selected
                  ? value.filter((id) => id !== s.id)
                  : [...value, s.id],
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
            {s.icon ? `${s.icon} ` : ""}
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const backLinkSt: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
  fontFamily: "var(--font-sans)",
};
