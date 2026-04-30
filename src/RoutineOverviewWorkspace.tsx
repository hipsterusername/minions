/**
 * RoutineOverviewWorkspace — the "what is this routine" task surface.
 *
 * Edits the routine-level metadata (name, id, description) and the user-
 * supplied inputs the routine accepts. Shown when selection.kind === "overview".
 *
 * The id field is presented as a small dashed override under the name; the
 * id auto-fills from the name as the user types until they explicitly
 * customise it. Inputs use the same pattern for `name`.
 */
import type { Routine, RoutineInput } from "../shared/routines/types.ts";
import { generateId, isAutoDerivedId, uniqueId } from "./routine-editor-shared.ts";
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
  subTitleSt,
  subtitleSt,
  titleSt,
  addBtnSt,
  btnBase,
} from "./routine-editor-styles.ts";

interface Props {
  draft: Routine;
  errors: Record<string, string>;
  onSetField: (field: "id" | "name" | "description", value: string) => void;
  onSetInputs: (inputs: RoutineInput[]) => void;
}

export function RoutineOverviewWorkspace({
  draft,
  errors,
  onSetField,
  onSetInputs,
}: Props) {
  return (
    <section
      aria-label="Routine overview"
      style={{ ...sectionSt, gap: 24 }}
    >
      {/* Header */}
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={eyebrowSt}>Overview</span>
        <h2 style={titleSt}>{draft.name || "New Routine"}</h2>
        <p style={subtitleSt}>
          Identify the routine and declare the inputs callers can supply at run
          time.
        </p>
      </header>

      {/* Routine info card */}
      <div style={cardSt}>
        <div>
          <label style={labelSt}>Name *</label>
          <input
            style={{
              ...inputSt,
              borderColor: errors["name"] ? "var(--danger-color)" : undefined,
            }}
            value={draft.name}
            onChange={(e) => onSetField("name", e.target.value)}
            placeholder="My Routine"
            aria-label="Routine name"
          />
          {errors["name"] && <div style={fieldErrSt}>{errors["name"]}</div>}
        </div>
        <div style={refRowSt}>
          <span style={refLabelSt}>Routine id</span>
          <code style={refCodeSt}>{draft.id || "…"}</code>
          <input
            style={{
              ...refInputSt,
              borderColor: errors["id"] ? "var(--danger-color)" : undefined,
            }}
            value={draft.id}
            onChange={(e) => onSetField("id", e.target.value)}
            placeholder="auto"
            aria-label="Routine ID"
          />
        </div>
        {errors["id"] && <div style={fieldErrSt}>{errors["id"]}</div>}
        <div style={{ marginTop: 12 }}>
          <label style={labelSt}>Description</label>
          <input
            style={inputSt}
            value={draft.description ?? ""}
            onChange={(e) => onSetField("description", e.target.value)}
            placeholder="What does this routine do?"
            aria-label="Routine description"
          />
        </div>
      </div>

      {/* Inputs card */}
      <InputsCard
        inputs={draft.inputs}
        errors={errors}
        onChange={onSetInputs}
      />
    </section>
  );
}

// ── Inputs card ─────────────────────────────────────────────────────────────

interface InputsCardProps {
  inputs: RoutineInput[];
  errors: Record<string, string>;
  onChange: (inputs: RoutineInput[]) => void;
}

function InputsCard({ inputs, errors, onChange }: InputsCardProps) {
  const addInput = () =>
    onChange([...inputs, { name: "", label: "", required: true }]);

  const updateInput = (
    idx: number,
    field: keyof RoutineInput,
    value: unknown,
  ) =>
    onChange(
      inputs.map((inp, i) => {
        if (i !== idx) return inp;
        const updated = { ...inp, [field]: value };
        if (field === "label" && isAutoDerivedId(inp.name, inp.label)) {
          const others = inputs.filter((_, j) => j !== idx).map((x) => x.name);
          updated.name = uniqueId(generateId(String(value)), others);
        }
        return updated;
      }),
    );

  const removeInput = (idx: number) =>
    onChange(inputs.filter((_, i) => i !== idx));

  return (
    <div style={cardSt}>
      <div style={subHeaderSt}>
        <h4 style={subTitleSt}>Inputs</h4>
        <button
          type="button"
          onClick={addInput}
          style={addBtnSt}
          aria-label="Add input"
        >
          + Add input
        </button>
      </div>
      {inputs.length === 0 ? (
        <div style={emptyStateSt}>
          No inputs yet — routines can be triggered without inputs too.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {inputs.map((inp, idx) => (
            <InputRow
              key={idx}
              input={inp}
              idx={idx}
              onChange={updateInput}
              onRemove={removeInput}
              error={
                errors[`inputs.${idx}.name`] ?? errors[`inputs.${idx}.label`]
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── InputRow ────────────────────────────────────────────────────────────────

interface InputRowProps {
  input: RoutineInput;
  idx: number;
  onChange: (idx: number, field: keyof RoutineInput, value: unknown) => void;
  onRemove: (idx: number) => void;
  error?: string | undefined;
}

function InputRow({ input, idx, onChange, onRemove, error }: InputRowProps) {
  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg-secondary)",
        border: `1px solid ${error ? "var(--danger-color)" : "var(--border-default)"}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 110px auto",
          gap: 10,
          alignItems: "end",
        }}
      >
        <div>
          <label style={labelSt}>Label *</label>
          <input
            style={inputSt}
            value={input.label}
            onChange={(e) => onChange(idx, "label", e.target.value)}
            placeholder="Topic to research"
            aria-label={`Input ${idx + 1} label`}
          />
        </div>
        <div>
          <label style={labelSt}>Default value</label>
          <input
            style={inputSt}
            value={input.defaultValue ?? ""}
            onChange={(e) =>
              onChange(idx, "defaultValue", e.target.value || undefined)
            }
            placeholder="Optional default"
            aria-label={`Input ${idx + 1} default value`}
          />
        </div>
        <div>
          <label style={labelSt}>Required</label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 0",
            }}
          >
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
          aria-label={`Remove input ${input.label || idx + 1}`}
          style={{
            ...btnBase,
            color: "var(--danger-color)",
            background: "transparent",
            alignSelf: "end",
          }}
        >
          ×
        </button>
      </div>
      <div style={refRowSt}>
        <span style={refLabelSt}>Reference as</span>
        <code style={refCodeSt}>{`{{inputs.${input.name || "…"}}}`}</code>
        <input
          style={refInputSt}
          value={input.name}
          onChange={(e) => onChange(idx, "name", e.target.value)}
          placeholder="auto"
          aria-label={`Input ${idx + 1} name`}
        />
      </div>
      {error && (
        <div
          style={{
            color: "var(--danger-color)",
            fontSize: 11,
            marginTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

