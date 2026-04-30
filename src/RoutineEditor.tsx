/**
 * RoutineEditor — visual editor for Routine JSON files.
 *
 * Replaces hand-editing `.claude-canvas/routines/<id>.json`. Two screens:
 *
 *   - **List view** — browse all routines for the project; New / Edit / Delete.
 *   - **Edit view** — three-zone layout:
 *       1. Header (name, save / cancel)
 *       2. Outline rail (left) — Inputs entry, ordered phases with step pips,
 *          add-phase, audit panel. The only navigation surface.
 *       3. Workspace (right) — exactly one task at a time:
 *          • Overview workspace  — routine metadata + inputs
 *          • Phase workspace     — phase metadata + step tile grid
 *          • Step workspace      — full step authoring editor
 *
 * Selection state (`Selection`) drives which workspace renders. The rail
 * is the single source of navigation; clicks set selection. Drag-reorder
 * lives in two scopes only: phases (in the rail) and steps within a phase
 * (in the phase workspace's tile grid).
 */

import { useState, useCallback, useEffect, type CSSProperties } from "react";
import type {
  Routine,
  RoutineInput,
  RoutinePhase,
  RoutineStep,
} from "../shared/routines/types.ts";
import {
  generateId,
  isAutoDerivedId,
  newPhase,
  newRoutine,
  newStep,
  uniqueId,
  validateDraft,
  type Selection,
} from "./routine-editor-shared.ts";
import { RoutineOutlineRail } from "./RoutineOutlineRail.tsx";
import { RoutineOverviewWorkspace } from "./RoutineOverviewWorkspace.tsx";
import { RoutinePhaseWorkspace } from "./RoutinePhaseWorkspace.tsx";
import { RoutineStepWorkspace } from "./RoutineStepWorkspace.tsx";
import {
  listProjectRoutines,
  saveProjectRoutine,
  deleteProjectRoutine,
  type RoutineListResult,
} from "./api.ts";
import { btnBase } from "./routine-editor-styles.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface RoutineEditorProps {
  projectId: string;
  onClose: () => void;
}

// ── RoutineEditView ─────────────────────────────────────────────────────────

interface RoutineEditViewProps {
  draft: Routine;
  saving: boolean;
  saveError: string | null;
  onClose: () => void;
  onSave: () => void;
  onChange: (draft: Routine) => void;
}

function RoutineEditView({
  draft,
  saving,
  saveError,
  onClose,
  onSave,
  onChange,
}: RoutineEditViewProps) {
  const validation = validateDraft(draft);
  const [selection, setSelection] = useState<Selection>(() => ({
    kind: "phase",
    phaseIdx: 0,
  }));

  // Clamp the selection if a phase / step gets removed underneath us.
  useEffect(() => {
    if (selection.kind === "phase" && selection.phaseIdx >= draft.phases.length) {
      setSelection({ kind: "overview" });
    } else if (selection.kind === "step") {
      const phase = draft.phases[selection.phaseIdx];
      if (!phase) {
        setSelection({ kind: "overview" });
      } else if (selection.stepIdx >= phase.steps.length) {
        setSelection({ kind: "phase", phaseIdx: selection.phaseIdx });
      }
    }
  }, [draft.phases, selection]);

  // ── Mutators ─────────────────────────────────────────────────────────────

  const setField = (field: "id" | "name" | "description", value: string) => {
    const next = { ...draft, [field]: value };
    if (field === "name" && isAutoDerivedId(draft.id, draft.name)) {
      next.id = generateId(value);
    }
    onChange(next);
  };

  const setInputs = (inputs: RoutineInput[]) => onChange({ ...draft, inputs });

  const changePhase = (
    phaseIdx: number,
    field: keyof RoutinePhase,
    value: unknown,
  ) => {
    const phases = draft.phases.map((p, i) => {
      if (i !== phaseIdx) return p;
      const updated = { ...p, [field]: value };
      if (field === "label" && isAutoDerivedId(p.id, p.label)) {
        const taken = draft.phases
          .filter((_, j) => j !== phaseIdx)
          .map((x) => x.id);
        updated.id = uniqueId(generateId(String(value)), taken);
      }
      return updated;
    });
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
      const steps = p.steps.map((s, si) => {
        if (si !== stepIdx) return s;
        const updated = { ...s, [field]: value };
        if (field === "label" && isAutoDerivedId(s.id, s.label)) {
          const taken = p.steps
            .filter((_, j) => j !== stepIdx)
            .map((x) => x.id);
          updated.id = uniqueId(generateId(String(value)), taken);
        }
        return updated;
      });
      return { ...p, steps };
    });
    onChange({ ...draft, phases });
  };

  const addStep = (phaseIdx: number) => {
    const phase = draft.phases[phaseIdx];
    if (!phase) return;
    const newIdx = phase.steps.length;
    const phases = draft.phases.map((p, i) =>
      i === phaseIdx
        ? { ...p, steps: [...p.steps, newStep(phaseIdx, newIdx)] }
        : p,
    );
    onChange({ ...draft, phases });
    setSelection({ kind: "step", phaseIdx, stepIdx: newIdx });
  };

  const removeStep = (phaseIdx: number, stepIdx: number) => {
    const phase = draft.phases[phaseIdx];
    if (!phase || phase.steps.length <= 1) {
      alert("A phase must contain at least one step.");
      return;
    }
    const phases = draft.phases.map((p, i) =>
      i === phaseIdx
        ? { ...p, steps: p.steps.filter((_, si) => si !== stepIdx) }
        : p,
    );
    onChange({ ...draft, phases });
    setSelection({ kind: "phase", phaseIdx });
  };

  const addPhase = () => {
    const phases = [...draft.phases, newPhase(draft.phases.length)];
    onChange({ ...draft, phases });
    setSelection({ kind: "phase", phaseIdx: phases.length - 1 });
  };

  const removePhase = (phaseIdx: number) => {
    if (draft.phases.length <= 1) return;
    const phases = draft.phases.filter((_, i) => i !== phaseIdx);
    onChange({ ...draft, phases });
    setSelection({ kind: "overview" });
  };

  const movePhase = (from: number, to: number) => {
    const phases = [...draft.phases];
    const [m] = phases.splice(from, 1);
    if (!m) return;
    phases.splice(to, 0, m);
    onChange({ ...draft, phases });
    if (selection.kind === "phase" && selection.phaseIdx === from) {
      setSelection({ kind: "phase", phaseIdx: to });
    } else if (selection.kind === "step" && selection.phaseIdx === from) {
      setSelection({ kind: "step", phaseIdx: to, stepIdx: selection.stepIdx });
    }
  };

  const moveStep = (phaseIdx: number, from: number, to: number) => {
    const phases = draft.phases.map((p, i) => {
      if (i !== phaseIdx) return p;
      const steps = [...p.steps];
      const [m] = steps.splice(from, 1);
      if (!m) return p;
      steps.splice(to, 0, m);
      return { ...p, steps };
    });
    onChange({ ...draft, phases });
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const totalSteps = draft.phases.reduce((acc, p) => acc + p.steps.length, 0);

  return (
    <>
      <header style={editorHeaderSt}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0, flex: 1 }}>
          <span style={titleEllipsisSt}>{draft.name || "New Routine"}</span>
          {draft.id && <span style={metaMonoSt}>{draft.id}</span>}
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            · {draft.phases.length} phase{draft.phases.length === 1 ? "" : "s"}{" "}
            · {totalSteps} step{totalSteps === 1 ? "" : "s"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              ...btnBase,
              background: "var(--bg-primary)",
              color: "var(--text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!validation.ok || saving}
            aria-disabled={!validation.ok || saving}
            title={
              !validation.ok ? "Fix validation errors before saving" : undefined
            }
            style={{
              ...btnBase,
              background:
                validation.ok && !saving ? "var(--accent)" : "var(--bg-elevated)",
              color: validation.ok && !saving ? "white" : "var(--text-muted)",
              border: `1px solid ${validation.ok ? "var(--accent)" : "var(--border-default)"}`,
              cursor: validation.ok && !saving ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
          >
            {saving ? "Saving…" : "Save & close"}
          </button>
        </div>
      </header>

      {(saveError || validation.globalErrors.length > 0) && (
        <div role="alert" style={errorBannerSt}>
          {saveError ?? validation.globalErrors.join(" · ")}
        </div>
      )}

      <div style={bodySt}>
        <RoutineOutlineRail
          routine={draft}
          selection={selection}
          errors={validation.fieldErrors}
          onSelect={setSelection}
          onAddPhase={addPhase}
          onMovePhase={movePhase}
        />
        <main style={workspaceSt}>
          <Workspace
            draft={draft}
            selection={selection}
            errors={validation.fieldErrors}
            onSetField={setField}
            onSetInputs={setInputs}
            onChangePhase={changePhase}
            onChangeStep={changeStep}
            onAddStep={addStep}
            onRemoveStep={removeStep}
            onMoveStep={moveStep}
            onRemovePhase={removePhase}
            onSelect={setSelection}
          />
        </main>
      </div>
    </>
  );
}

// ── Workspace router ────────────────────────────────────────────────────────

interface WorkspaceProps {
  draft: Routine;
  selection: Selection;
  errors: Record<string, string>;
  onSetField: (field: "id" | "name" | "description", value: string) => void;
  onSetInputs: (inputs: RoutineInput[]) => void;
  onChangePhase: (
    phaseIdx: number,
    field: keyof RoutinePhase,
    value: unknown,
  ) => void;
  onChangeStep: (
    phaseIdx: number,
    stepIdx: number,
    field: keyof RoutineStep,
    value: unknown,
  ) => void;
  onAddStep: (phaseIdx: number) => void;
  onRemoveStep: (phaseIdx: number, stepIdx: number) => void;
  onMoveStep: (phaseIdx: number, from: number, to: number) => void;
  onRemovePhase: (phaseIdx: number) => void;
  onSelect: (next: Selection) => void;
}

function Workspace(props: WorkspaceProps) {
  const { draft, selection, errors } = props;
  if (selection.kind === "overview") {
    return (
      <RoutineOverviewWorkspace
        draft={draft}
        errors={errors}
        onSetField={props.onSetField}
        onSetInputs={props.onSetInputs}
      />
    );
  }
  if (selection.kind === "phase") {
    const phase = draft.phases[selection.phaseIdx];
    if (!phase) return null;
    return (
      <RoutinePhaseWorkspace
        phase={phase}
        phaseIdx={selection.phaseIdx}
        draft={draft}
        errors={errors}
        totalPhases={draft.phases.length}
        onChangePhase={props.onChangePhase}
        onAddStep={props.onAddStep}
        onMoveStep={props.onMoveStep}
        onOpenStep={(phaseIdx, stepIdx) =>
          props.onSelect({ kind: "step", phaseIdx, stepIdx })
        }
        onRemovePhase={props.onRemovePhase}
      />
    );
  }
  // selection.kind === "step"
  const phase = draft.phases[selection.phaseIdx];
  const step = phase?.steps[selection.stepIdx];
  if (!phase || !step) return null;
  return (
    <RoutineStepWorkspace
      step={step}
      phaseIdx={selection.phaseIdx}
      stepIdx={selection.stepIdx}
      draft={draft}
      errors={errors}
      onChange={props.onChangeStep}
      onBack={() =>
        props.onSelect({ kind: "phase", phaseIdx: selection.phaseIdx })
      }
      onRemove={() =>
        props.onRemoveStep(selection.phaseIdx, selection.stepIdx)
      }
    />
  );
}

// ── RoutineListView ─────────────────────────────────────────────────────────

interface RoutineListViewProps {
  routines: Routine[];
  invalid: RoutineListResult["invalid"];
  loading: boolean;
  onEdit: (r: Routine) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function RoutineListView({
  routines,
  invalid,
  loading,
  onEdit,
  onNew,
  onDelete,
}: RoutineListViewProps) {
  return (
    <>
      <div style={editorHeaderSt}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>Routines</span>
        <button
          type="button"
          onClick={onNew}
          style={{
            ...btnBase,
            background: "var(--accent)",
            color: "white",
            border: "1px solid var(--accent)",
            fontWeight: 600,
          }}
        >
          + New routine
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
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
              padding: "12px 14px",
              background: "var(--bg-primary)",
              border: "1px solid var(--border-default)",
              borderRadius: 8,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{r.name}</div>
              {r.description && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    marginTop: 2,
                  }}
                >
                  {r.description}
                </div>
              )}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  marginTop: 4,
                }}
              >
                {r.id} · {r.phases.length} phase
                {r.phases.length !== 1 ? "s" : ""}
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
              style={{
                ...btnBase,
                color: "var(--danger-color)",
                background: "none",
                border: "1px solid var(--danger-color)",
              }}
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

// ── RoutineEditor (main export) ─────────────────────────────────────────────

export function RoutineEditor({ projectId, onClose }: RoutineEditorProps) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [invalid, setInvalid] = useState<RoutineListResult["invalid"]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | null>(null);
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
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const openNew = useCallback(() => {
    setEditing(newRoutine());
    setSaveError(null);
  }, []);

  const openEdit = useCallback((r: Routine) => {
    setEditing({ ...r });
    setSaveError(null);
  }, []);

  const handleDelete = useCallback(
    async (routineId: string) => {
      await deleteProjectRoutine(projectId, routineId);
      setRoutines((prev) => prev.filter((r) => r.id !== routineId));
    },
    [projectId],
  );

  const handleSave = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveProjectRoutine(projectId, editing);
      setRoutines((prev) => {
        const idx = prev.findIndex((r) => r.id === saved.id);
        return idx >= 0
          ? prev.map((r, i) => (i === idx ? saved : r))
          : [...prev, saved];
      });
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [editing, projectId]);

  const handleClose = useCallback(() => {
    if (editing) setEditing(null);
    else onClose();
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
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 22,
            cursor: "pointer",
            zIndex: 10,
          }}
        >
          ×
        </button>

        {editing ? (
          <RoutineEditView
            draft={editing}
            saving={saving}
            saveError={saveError}
            onClose={() => setEditing(null)}
            onSave={() => void handleSave()}
            onChange={setEditing}
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

// ── Styles ──────────────────────────────────────────────────────────────────

const overlaySt: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-bg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const modalSt: CSSProperties = {
  position: "relative",
  width: "min(1280px, 96vw)",
  height: "min(880px, 92vh)",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 10,
  fontFamily: "var(--font-sans)",
  color: "var(--text-primary)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "var(--shadow-lg)",
};

const editorHeaderSt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 56px 12px 20px",
  borderBottom: "1px solid var(--border-default)",
  background: "var(--bg-primary)",
  flexShrink: 0,
};

const titleEllipsisSt: CSSProperties = {
  fontWeight: 600,
  fontSize: 15,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaMonoSt: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const errorBannerSt: CSSProperties = {
  padding: "8px 16px",
  background: "var(--error-bg)",
  color: "var(--danger-color)",
  fontSize: 12,
};

const bodySt: CSSProperties = {
  display: "flex",
  flex: 1,
  overflow: "hidden",
};

const workspaceSt: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "24px 32px 32px",
  background:
    "radial-gradient(circle at top, rgba(240, 136, 62, 0.04), transparent 60%), var(--bg-secondary)",
};
