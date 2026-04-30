/**
 * DAG-mode routine scheduler + shared step-execution helpers.
 *
 * Extracted from scheduler.ts so that file stays under 400 lines. This
 * module has two responsibilities:
 *
 *   1. Export the step-retry helper ({@link runStepWithRetries}), the
 *      snapshot clone utility ({@link cloneSnapshot}), and the settled-step
 *      type ({@link SettledStep}) that the phases-mode scheduler also uses.
 *
 *   2. Export {@link runRoutineDag}, which is called by scheduler.ts when any
 *      step in the routine declares `dependsOn`.
 *
 * DAG algorithm
 * ─────────────
 *   1. Flatten all steps from all phases into one list.
 *   2. Kick off every step whose declared deps are already satisfied
 *      (initially: steps with empty dependsOn).
 *   3. Await the next completion via Promise.race across the running set.
 *   4. On error/abort: mark remaining pending steps as skipped, fail fast.
 *   5. On success: record the result, start any newly unblocked steps.
 *   6. Repeat until the running set is empty.
 *
 * The snapshot emitted at each state transition carries `mode: "dag"` and
 * a `dagSteps` list with resolved dep edges so the UI can render a flat
 * step list (and, in future, a graph view).
 */

// Type-only import — erased at runtime, no circular dependency at runtime.
import type { StepRunArgs, StepRunner } from "./scheduler.ts";
import { buildDependsContext } from "./handoff.ts";
import { renderTemplate } from "./template.ts";
import type {
  DagStepState,
  Routine,
  RoutineInputValues,
  RoutinePhase,
  RoutineRunSnapshot,
  RoutineStep,
  StepResult,
} from "../../shared/routines/types.ts";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Shape returned by {@link runStepWithRetries}. */
export type SettledStep =
  | { ok: true; result: StepResult; attempts: number }
  | { ok: false; stepId: string; error: string; attempts: number };

/**
 * Deep-clone a snapshot so mutation between emits cannot corrupt prior
 * frames the consumer is still holding. JSON round-trip is safe — every
 * field on the snapshot is JSON-representable by construction.
 */
export function cloneSnapshot(snap: RoutineRunSnapshot): RoutineRunSnapshot {
  return JSON.parse(JSON.stringify(snap)) as RoutineRunSnapshot;
}

/**
 * Run a single step, retrying up to `step.retries` times when the outcome
 * is "error". Aborted outcomes are never retried — abort is intentional.
 *
 * `onAttemptFailed` is called after each failed attempt so the scheduler
 * can emit an intermediate snapshot showing retry state.
 */
export async function runStepWithRetries(
  args: StepRunArgs,
  runner: StepRunner,
  onAttemptFailed: (attempt: number, error: string) => void,
): Promise<SettledStep> {
  const maxRetries = args.step.retries;
  let attempt = 0;
  while (true) {
    attempt += 1;
    let result: StepResult;
    try {
      result = await runner(args);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (attempt > maxRetries) {
        return { ok: false, stepId: args.step.id, error, attempts: attempt };
      }
      onAttemptFailed(attempt, error);
      continue;
    }
    // Aborted is intentional — never retry.
    if (result.outcome === "error" && attempt <= maxRetries) {
      onAttemptFailed(attempt, result.error ?? result.summary);
      continue;
    }
    return { ok: true, result, attempts: attempt };
  }
}

// ── DAG scheduler ─────────────────────────────────────────────────────────────

/** Arguments for the DAG run — inputs are already validated by the caller. */
export interface DagRunArgs {
  routine: Routine;
  validatedInputs: RoutineInputValues;
  runner: StepRunner;
  runId: string;
  onSnapshot?: (snapshot: RoutineRunSnapshot) => void;
  now?: () => string;
}

interface FlatStep {
  step: RoutineStep;
  phase: RoutinePhase;
}

function flattenSteps(routine: Routine): FlatStep[] {
  return routine.phases.flatMap((phase) =>
    phase.steps.map((step) => ({ step, phase })),
  );
}

/**
 * Run a routine in DAG mode.
 *
 * Steps start as soon as all their declared deps have succeeded.
 * Fail-fast: the first error or abort terminates the run immediately.
 */
export async function runRoutineDag({
  routine,
  validatedInputs,
  runner,
  runId,
  onSnapshot,
  now = () => new Date().toISOString(),
}: DagRunArgs): Promise<RoutineRunSnapshot> {
  const allSteps = flattenSteps(routine);

  const dagSteps: DagStepState[] = allSteps.map(({ step, phase }) => ({
    stepId: step.id,
    label: step.label,
    phaseId: phase.id,
    dependsOn: step.dependsOn ?? [],
    state: "pending" as const,
  }));

  const snapshot: RoutineRunSnapshot = {
    runId,
    routineId: routine.id,
    routineName: routine.name,
    state: "running",
    inputs: validatedInputs,
    phases: routine.phases.map((p) => ({
      phaseId: p.id,
      label: p.label,
      state: "pending" as const,
      steps: p.steps.map((s) => ({ stepId: s.id, label: s.label })),
    })),
    startedAt: now(),
    mode: "dag",
    dagSteps,
  };

  const emit = (): void => onSnapshot?.(cloneSnapshot(snapshot));
  emit();

  /** Completed step results, keyed by stepId. */
  const completedResults = new Map<string, StepResult>();
  /** Steps currently executing: stepId → promise resolving when done. */
  const running = new Map<
    string,
    Promise<{ stepId: string; settled: SettledStep }>
  >();
  /** IDs of steps that have reached a terminal state (success, error, skipped). */
  const terminalIds = new Set<string>();

  const findDagStep = (id: string): DagStepState => {
    const entry = dagSteps.find((s) => s.stepId === id);
    if (!entry) throw new Error(`DAG: no dagStep entry for step "${id}"`);
    return entry;
  };

  const depsAllSucceeded = (depIds: readonly string[]): boolean =>
    depIds.every((id) => completedResults.get(id)?.outcome === "success");

  const launchStep = ({ step, phase }: FlatStep): void => {
    const depIds = step.dependsOn ?? [];
    const depResults = new Map<string, StepResult>();
    for (const depId of depIds) {
      const r = completedResults.get(depId);
      if (r) depResults.set(depId, r);
    }
    const depends =
      depIds.length > 0
        ? buildDependsContext(depIds, depResults)
        : undefined;

    const { text, unresolved } = renderTemplate(step.routinePrompt, {
      inputs: validatedInputs,
      ...(depends !== undefined ? { depends } : {}),
      phase: { id: phase.id, label: phase.label },
      step: { id: step.id, label: step.label },
    });

    findDagStep(step.id).state = "running";
    emit();

    const stepArgs: StepRunArgs = {
      step,
      phase,
      renderedPrompt: text,
      unresolved,
      handoff: undefined,
      inputs: validatedInputs,
      runId,
    };

    const phaseSnap = snapshot.phases.find((p) => p.phaseId === phase.id);
    const promise = runStepWithRetries(
      stepArgs,
      runner,
      (attempt, error) => {
        const stepEntry = phaseSnap?.steps.find((s) => s.stepId === step.id);
        if (stepEntry) {
          stepEntry.attempts = attempt;
          stepEntry.lastError = error;
        }
        emit();
      },
    ).then((settled) => ({ stepId: step.id, settled }));

    running.set(step.id, promise);
  };

  // Initial wave: steps with no deps (or whose deps are trivially met).
  for (const flat of allSteps) {
    if (depsAllSucceeded(flat.step.dependsOn ?? [])) launchStep(flat);
  }

  while (running.size > 0) {
    const { stepId, settled } = await Promise.race([...running.values()]);
    running.delete(stepId);

    const flat = allSteps.find((f) => f.step.id === stepId)!;
    const dagEntry = findDagStep(stepId);
    const phaseSnap = snapshot.phases.find((p) => p.phaseId === flat.phase.id)!;
    const stepEntry = phaseSnap.steps.find((s) => s.stepId === stepId)!;

    if (!settled.ok) {
      // Runner threw and exhausted retries.
      dagEntry.state = "error";
      dagEntry.outcome = "error";
      stepEntry.outcome = "error";
      stepEntry.lastError = settled.error;
      stepEntry.attempts = settled.attempts;
      terminalIds.add(stepId);
      for (const f of allSteps) {
        if (!terminalIds.has(f.step.id) && !running.has(f.step.id)) {
          findDagStep(f.step.id).state = "skipped";
        }
      }
      snapshot.state = "error";
      snapshot.error = `step "${stepId}" runner threw: ${settled.error}`;
      snapshot.endedAt = now();
      emit();
      return cloneSnapshot(snapshot);
    }

    const result = settled.result;
    stepEntry.outcome = result.outcome;
    stepEntry.summary = result.summary;
    stepEntry.attempts = settled.attempts;
    if (result.sessionKey) {
      stepEntry.sessionKey = result.sessionKey;
      dagEntry.sessionKey = result.sessionKey;
    }

    if (result.outcome === "error" || result.outcome === "aborted") {
      const reason =
        result.outcome === "aborted"
          ? `step "${stepId}" was aborted`
          : `step "${stepId}" reported error: ${result.error ?? "(no message)"}`;
      dagEntry.state = "error";
      dagEntry.outcome = result.outcome;
      terminalIds.add(stepId);
      for (const f of allSteps) {
        if (!terminalIds.has(f.step.id) && !running.has(f.step.id)) {
          findDagStep(f.step.id).state = "skipped";
        }
      }
      snapshot.state = "error";
      snapshot.error = reason;
      snapshot.endedAt = now();
      emit();
      return cloneSnapshot(snapshot);
    }

    // Step succeeded — record result, unlock dependents.
    dagEntry.state = "success";
    dagEntry.outcome = "success";
    dagEntry.summary = result.summary;
    completedResults.set(stepId, result);
    terminalIds.add(stepId);
    emit();

    for (const f of allSteps) {
      if (
        !terminalIds.has(f.step.id) &&
        !running.has(f.step.id) &&
        depsAllSucceeded(f.step.dependsOn ?? [])
      ) {
        launchStep(f);
      }
    }
  }

  snapshot.state = "success";
  snapshot.endedAt = now();
  emit();
  return cloneSnapshot(snapshot);
}
