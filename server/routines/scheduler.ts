/**
 * Routine phase scheduler.
 *
 * Pure orchestration logic. Takes a `Routine` + `RoutineInputValues` + an
 * injected `StepRunner` and runs the routine to completion, returning the
 * final `RoutineRunSnapshot`. Does *not* know how to spawn Leader sessions
 * — that's the runner's job. This separation lets us:
 *
 *   1. Test the scheduler exhaustively with fake runners (no SDK loop, no
 *      worktrees, no WebSockets).
 *   2. Swap in the real spawn implementation in Phase B as a one-line wire-
 *      up without touching the orchestration code.
 *
 * Lifecycle
 * ─────────
 *   1. Validate inputs against the routine's input schema (required + types).
 *   2. For each phase in declared order:
 *        a. Render every step's prompt against the templating context
 *           (inputs + accumulated handoff so far).
 *        b. Invoke the runner once per step in parallel (Promise.all).
 *        c. If any step returns outcome=error, mark the run as failed,
 *           emit a final snapshot, and return (fail-fast).
 *        d. Otherwise reduce the phase result into a HandoffPayload and
 *           feed it into the next phase's templating context.
 *   3. Return the final snapshot with state="success" and per-phase status.
 *
 * Progress events
 * ───────────────
 *   The scheduler accepts an optional `onSnapshot` callback that receives
 *   the latest snapshot every time the run state changes (run started,
 *   phase started, step complete, phase reduced, run ended). This is the
 *   single hook the bus integration in Phase B will use.
 */

import {
  reducePhase,
  type ReduceArgs,
} from "./handoff.ts";
import { renderTemplate } from "./template.ts";
import {
  cloneSnapshot,
  runRoutineDag,
  runStepWithRetries,
  type SettledStep,
} from "./scheduler-dag.ts";
import type {
  HandoffPayload,
  PhaseResult,
  Routine,
  RoutineInput,
  RoutineInputValues,
  RoutinePhase,
  RoutineRunSnapshot,
  RoutineStep,
  StepResult,
} from "../../shared/routines/types.ts";

export type { SettledStep };

/**
 * What the scheduler hands the runner. The runner returns a StepResult
 * (or a Promise of one). The runner is also responsible for surfacing
 * the spawned session key on the result so the UI can link to it.
 */
export interface StepRunArgs {
  /** The original step definition. */
  step: RoutineStep;
  /** The phase this step belongs to. */
  phase: RoutinePhase;
  /** The fully-rendered prompt the runner should send the agent. */
  renderedPrompt: string;
  /** Names of any unresolved `{{paths}}` so the runner can warn. */
  unresolved: string[];
  /** The handoff from the previous phase, if any. */
  handoff: HandoffPayload | undefined;
  /** Original inputs (for runners that compose extra context). */
  inputs: RoutineInputValues;
  /** Stable run id for downstream correlation/logging. */
  runId: string;
}

/** Pluggable runner. The fake variant powers tests; the real one spawns Leaders. */
export type StepRunner = (args: StepRunArgs) => Promise<StepResult>;

export interface RunRoutineArgs {
  routine: Routine;
  inputs: RoutineInputValues;
  runner: StepRunner;
  /** Pre-generated run id — supply for deterministic tests. */
  runId: string;
  /** Called every time the snapshot changes. Synchronous. */
  onSnapshot?: (snapshot: RoutineRunSnapshot) => void;
  /** Provide for deterministic timestamps in tests. */
  now?: () => string;
}

/**
 * Validate user-supplied inputs against the routine's declared inputs.
 * Returns the coerced value bag, or throws with a list of all violations.
 */
export function validateInputs(
  declared: readonly RoutineInput[],
  supplied: Readonly<Record<string, unknown>>,
): RoutineInputValues {
  const errors: string[] = [];
  const out: Record<string, string | number | boolean> = {};
  for (const decl of declared) {
    const raw = supplied[decl.name];
    if (raw === undefined || raw === null || raw === "") {
      if (decl.required) {
        if (decl.defaultValue !== undefined) {
          out[decl.name] = decl.defaultValue;
        } else {
          errors.push(`missing required input "${decl.name}"`);
        }
      } else if (decl.defaultValue !== undefined) {
        out[decl.name] = decl.defaultValue;
      }
      continue;
    }
    if (decl.type === "string" && typeof raw === "string") {
      out[decl.name] = raw;
    } else if (decl.type === "number" && typeof raw === "number") {
      out[decl.name] = raw;
    } else if (decl.type === "boolean" && typeof raw === "boolean") {
      out[decl.name] = raw;
    } else {
      errors.push(
        `input "${decl.name}" must be a ${decl.type} (got ${typeof raw})`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid routine inputs: ${errors.join("; ")}`);
  }
  return out;
}

/**
 * Run a routine to completion. Pure async — see file header for lifecycle.
 */
export async function runRoutine({
  routine,
  inputs,
  runner,
  runId,
  onSnapshot,
  now = () => new Date().toISOString(),
}: RunRoutineArgs): Promise<RoutineRunSnapshot> {
  const validatedInputs = validateInputs(routine.inputs, inputs);

  // When any step declares `dependsOn`, the whole routine runs in DAG mode.
  const isDag = routine.phases.some((p) =>
    p.steps.some((s) => (s.dependsOn?.length ?? 0) > 0),
  );
  if (isDag) {
    return runRoutineDag({ routine, validatedInputs, runner, runId, onSnapshot, now });
  }

  const snapshot: RoutineRunSnapshot = {
    runId,
    routineId: routine.id,
    routineName: routine.name,
    state: "pending",
    inputs: validatedInputs,
    phases: routine.phases.map((p) => ({
      phaseId: p.id,
      label: p.label,
      state: "pending",
      steps: p.steps.map((s) => ({ stepId: s.id, label: s.label })),
    })),
    startedAt: now(),
  };

  const emit = (): void => onSnapshot?.(cloneSnapshot(snapshot));

  snapshot.state = "running";
  emit();

  let handoff: HandoffPayload | undefined;

  for (let i = 0; i < routine.phases.length; i += 1) {
    const phase = routine.phases[i]!;
    const phaseSnap = snapshot.phases[i]!;
    phaseSnap.state = "running";
    emit();

    // Render every step prompt up front so we have stable text to hand
    // to the runner and to surface unresolved placeholders together.
    const prepared = phase.steps.map((step) => {
      const { text, unresolved } = renderTemplate(step.routinePrompt, {
        inputs: validatedInputs,
        ...(handoff !== undefined ? { handoff } : {}),
        phase: { id: phase.id, label: phase.label },
        step: { id: step.id, label: step.label },
      });
      return { step, renderedPrompt: text, unresolved };
    });

    // Run all steps in parallel, each with its own retry loop.
    const settled = await Promise.all(
      prepared.map(({ step, renderedPrompt, unresolved }) =>
        runStepWithRetries(
          {
            step,
            phase,
            renderedPrompt,
            unresolved,
            handoff,
            inputs: validatedInputs,
            runId,
          },
          runner,
          (attempt, error) => {
            // Emit an intermediate snapshot so the UI can show retry state.
            const stepEntry = phaseSnap.steps.find((s) => s.stepId === step.id);
            if (stepEntry) {
              stepEntry.attempts = attempt;
              stepEntry.lastError = error;
            }
            emit();
          },
        ),
      ),
    );

    const stepResults: StepResult[] = [];
    let phaseFailed = false;
    let phaseError: string | undefined;

    for (let j = 0; j < settled.length; j += 1) {
      const settledItem = settled[j]!;
      const stepDef = phase.steps[j]!;
      if (!settledItem.ok) {
        phaseFailed = true;
        phaseError = `step "${stepDef.id}" runner threw: ${settledItem.error}`;
        const synthetic: StepResult = {
          stepId: stepDef.id,
          outcome: "error",
          summary: "",
          outputs: {},
          artifacts: [],
          error: settledItem.error,
        };
        stepResults.push(synthetic);
        recordStep(phaseSnap, synthetic, settledItem.attempts);
        continue;
      }
      const r = settledItem.result;
      stepResults.push(r);
      recordStep(phaseSnap, r, settledItem.attempts);
      if (r.outcome === "error") {
        phaseFailed = true;
        phaseError = `step "${stepDef.id}" reported error: ${r.error ?? "(no message)"}`;
      }
      if (r.outcome === "aborted") {
        phaseFailed = true;
        phaseError = `step "${stepDef.id}" was aborted`;
      }
    }

    if (phaseFailed) {
      phaseSnap.state = "error";
      // Mark every later phase as skipped under fail-fast.
      for (let k = i + 1; k < snapshot.phases.length; k += 1) {
        snapshot.phases[k]!.state = "skipped";
      }
      snapshot.state = "error";
      snapshot.error = phaseError;
      snapshot.endedAt = now();
      emit();
      return cloneSnapshot(snapshot);
    }

    const phaseResult: PhaseResult = {
      phaseId: phase.id,
      steps: stepResults,
    };
    const reduceArgs: ReduceArgs = {
      phase,
      result: phaseResult,
      inputs: validatedInputs,
    };
    handoff = reducePhase(reduceArgs);
    phaseSnap.handoff = handoff;
    phaseSnap.state = "success";
    emit();
  }

  snapshot.state = "success";
  snapshot.endedAt = now();
  emit();
  return cloneSnapshot(snapshot);
}

/**
 * Update the per-step entry in a phase snapshot in place. Pulls only the
 * fields the snapshot exposes — full result + outputs stay on the runner
 * side and travel via the broadcasted handoff.
 */
function recordStep(
  phaseSnap: RoutineRunSnapshot["phases"][number],
  result: StepResult,
  attempts?: number,
): void {
  const entry = phaseSnap.steps.find((s) => s.stepId === result.stepId);
  if (!entry) return;
  entry.outcome = result.outcome;
  entry.summary = result.summary;
  if (result.sessionKey) entry.sessionKey = result.sessionKey;
  if (attempts !== undefined) entry.attempts = attempts;
  if (result.outcome === "error") {
    entry.lastError = result.error ?? result.summary;
  }
}

// runStepWithRetries, cloneSnapshot, and SettledStep live in scheduler-dag.ts
// and are imported above. They are shared between the phases and DAG paths.
