/**
 * Shared helpers and types for the Routine editor surfaces.
 *
 * Pure logic — no JSX. Splits the responsibility between the orchestration
 * shell (RoutineEditor.tsx), the structural rail (RoutineOutlineRail.tsx),
 * and the three task surfaces (Overview / Phase / Step Workspace).
 */
import type {
  Routine,
  RoutineInput,
  RoutinePhase,
  RoutineStep,
} from "../shared/routines/types.ts";
import {
  safeParseRoutine,
  findDuplicateIds,
} from "../shared/routines/types.ts";

// ── Selection model ─────────────────────────────────────────────────────────

/**
 * Discriminated union driving which workspace renders. Only one task surface
 * is visible at a time; the rail is the only navigation.
 */
export type Selection =
  | { kind: "overview" }
  | { kind: "phase"; phaseIdx: number }
  | { kind: "step"; phaseIdx: number; stepIdx: number };

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  fieldErrors: Record<string, string>;
  globalErrors: string[];
}

export function validateDraft(draft: Routine): ValidationResult {
  const parsed = safeParseRoutine(draft);
  if (!parsed.ok) {
    const fieldErrors: Record<string, string> = {};
    const globalErrors: string[] = [];
    for (const { path, message } of parsed.errors) {
      if (path) fieldErrors[path] = message;
      else globalErrors.push(message);
    }
    return { ok: false, fieldErrors, globalErrors };
  }
  const dups = findDuplicateIds(parsed.routine);
  if (dups.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const dup of dups) fieldErrors[dup] = `Duplicate id: ${dup}`;
    return {
      ok: false,
      fieldErrors,
      globalErrors: dups.map((d) => `Duplicate id: ${d}`),
    };
  }
  return { ok: true, fieldErrors: {}, globalErrors: [] };
}

// ── ID derivation ───────────────────────────────────────────────────────────

export function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Resolve a candidate id against existing siblings, appending `-2`, `-3`, …
 * until unique.
 */
export function uniqueId(candidate: string, taken: readonly string[]): string {
  if (!candidate) return "";
  if (!taken.includes(candidate)) return candidate;
  let n = 2;
  while (taken.includes(`${candidate}-${n}`)) n += 1;
  return `${candidate}-${n}`;
}

/**
 * Returns true when the current id appears to be the auto-derivation of the
 * current label — used to keep id in sync with label until the user edits
 * the id directly.
 */
export function isAutoDerivedId(id: string, label: string): boolean {
  if (id === "") return true;
  const auto = generateId(label);
  if (id === auto) return true;
  return /^.+-\d+$/.test(id) && id.replace(/-\d+$/, "") === auto;
}

// ── Factories ───────────────────────────────────────────────────────────────

export function newStep(_phaseIdx: number, stepIdx: number): RoutineStep {
  const label = `Step ${stepIdx + 1}`;
  return {
    id: generateId(label),
    label,
    agent: "leader" as const,
    routinePrompt: "",
    skillIds: [],
    skillValues: {},
    mcpServerIds: [],
    retries: 0,
  };
}

export function newPhase(phaseIdx: number): RoutinePhase {
  const label = `Phase ${phaseIdx + 1}`;
  return {
    id: generateId(label),
    label,
    description: "",
    steps: [newStep(phaseIdx, 0)],
  };
}

export function newRoutine(): Routine {
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

// ── Error helpers ───────────────────────────────────────────────────────────

/** Returns the validation error keys touching a specific step. */
export function stepHasError(
  errors: Record<string, string>,
  phaseIdx: number,
  stepIdx: number,
): boolean {
  const prefix = `phases.${phaseIdx}.steps.${stepIdx}.`;
  return Object.keys(errors).some((k) => k.startsWith(prefix));
}

/** Returns the validation error keys touching a specific phase (excluding its steps). */
export function phaseHasError(
  errors: Record<string, string>,
  phaseIdx: number,
): boolean {
  const idKey = `phases.${phaseIdx}.id`;
  const labelKey = `phases.${phaseIdx}.label`;
  return errors[idKey] !== undefined || errors[labelKey] !== undefined;
}

/** Returns true when any input row has a validation error. */
export function inputsHaveError(
  errors: Record<string, string>,
  inputCount: number,
): boolean {
  for (let i = 0; i < inputCount; i++) {
    if (errors[`inputs.${i}.name`] || errors[`inputs.${i}.label`]) return true;
  }
  return false;
}

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { Routine, RoutineInput, RoutinePhase, RoutineStep };
