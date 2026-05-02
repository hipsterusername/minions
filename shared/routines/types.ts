/**
 * Routines — typed orchestration templates.
 *
 * **Single source of truth.** Both the server (scheduler, store, MCP tool
 * factories) and the client (RoutineNode, browsers, future editors) import
 * from this module. Zod schemas live alongside the TypeScript types so the
 * server can validate JSON loaded from disk and the client can validate
 * payloads received over the bus.
 *
 * Conceptual model
 * ────────────────
 *   Routine        A reusable template: inputs + ordered phases.
 *   Phase          A barrier-synced unit. Steps within a phase run in
 *                  parallel; phases run strictly in declared order.
 *   Step           One agent task — a Leader spawn config (system prompt
 *                  + routine prompt + skills + MCP servers).
 *   HandoffPayload The structured context produced by phase N's reducer
 *                  and injected into phase N+1's step prompts.
 *   Run            A live execution of a routine; tracked per-instance
 *                  with a runId and per-phase status.
 *
 * Design constraints
 * ──────────────────
 *   - Steps reference *ids* (skillIds, mcpServerIds) not inline content.
 *     The runtime resolves them at spawn time so a routine file is small
 *     and shareable.
 *   - Templating uses Mustache-flavour `{{path.to.value}}` — explicit and
 *     impossible to confuse with an expression language. The set of
 *     resolvable paths is documented in `routine-templating.md`.
 *   - Failure policy is fail-fast in v1. The schema accepts a `failurePolicy`
 *     field reserved for future expansion; today only "fail-fast" parses.
 */

import { z } from "zod/v4";

// ── Identifiers ────────────────────────────────────────────────────────────

/** Lower-kebab id: letters, digits, dash, underscore. Used for routines,
 *  phases, steps. Matches the convention skills/MCP servers already use. */
export const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message:
      "ids must start with a lowercase letter or digit and contain only [a-z0-9_-]",
  });

// ── Inputs ─────────────────────────────────────────────────────────────────

/**
 * An input the user supplies when triggering a Routine run.
 *
 * Inputs are always strings — they exist to fill `{{inputs.<name>}}` slots in
 * step prompts, and the prompt is text. Earlier versions carried a typed
 * `type: "string" | "number" | "boolean"` field; that knob added no value
 * (everything stringified at render time anyway) so it's been removed.
 *
 * Legacy routine files that include `type` or non-string defaults are still
 * loadable: the unknown `type` field is dropped and `defaultValue` is coerced
 * to a string by the schema's transform.
 */
export const routineInputSchema = z.object({
  name: idSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(true),
  /**
   * Optional default value. Always stored as a string. Legacy routine files
   * with `defaultValue: 3` or `defaultValue: true` are coerced.
   */
  defaultValue: z
    .union([z.string(), z.number(), z.boolean()])
    .transform((v) => (v === undefined ? undefined : String(v)))
    .optional(),
});

export type RoutineInput = z.infer<typeof routineInputSchema>;

/** Concrete value bag the runtime hands to template rendering. */
export type RoutineInputValues = Readonly<Record<string, string>>;

// ── Steps ──────────────────────────────────────────────────────────────────

/**
 * One agent task within a phase. The runtime spawns a Leader session per
 * step, composes its system prompt from `systemPrompt` (or the default
 * Leader prompt) plus the resolved skill addendum plus the handoff block
 * from the previous phase, then sends `routinePrompt` as the initial
 * user message.
 *
 * `mcpServerIds` is accepted for forward compatibility — v1 wires only
 * the built-in agent MCP servers (task-manager + render-dashboard).
 * External MCP server attachment is a separate PR.
 */
export const routineStepSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  /** Defaults to "leader" when omitted. v1 only supports leader. */
  agent: z.literal("leader").default("leader"),
  /** Optional override of the base agent system prompt. */
  systemPrompt: z.string().optional(),
  /**
   * The user-facing instruction sent as the step's first message. Supports
   * `{{inputs.x}}` and `{{handoff.brief|facts.x|step.id.summary}}` paths.
   */
  routinePrompt: z.string().min(1),
  /** Skill ids resolved against the project's skills.json at spawn. */
  skillIds: z.array(idSchema).default([]),
  /**
   * Per-skill `{{placeholder}}` values, shape: { skillId: { var: value } }.
   * Mirrors the existing `assign_task` skillValues param.
   */
  skillValues: z.record(z.string(), z.record(z.string(), z.string())).default(
    {},
  ),
  /**
   * MCP server ids to attach to this step. **v1 stores only.** The runtime
   * accepts the field but does not yet wire external MCP servers — that
   * capability lands in a separate PR.
   */
  mcpServerIds: z.array(idSchema).default([]),
  /**
   * Wall-clock deadline for this step in milliseconds. When the step's
   * leader session has not reported a result within this window, the runner
   * aborts the session and returns outcome="error". Omit to run without a
   * deadline (the existing behaviour).
   */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * How many additional attempts the scheduler makes after an outcome=error.
   * Aborted outcomes are never retried — abort is intentional. Defaults to
   * 0 (no retries, fail-fast on first error).
   */
  retries: z.number().int().nonnegative().default(0),
  /**
   * Declared dependencies for DAG mode. When any step in the routine
   * declares `dependsOn`, the scheduler switches to DAG mode for the whole
   * routine: steps run as soon as all their declared deps complete, and
   * phase barriers are ignored.
   *
   * Each entry must be a step id that exists elsewhere in the routine. Ids
   * must be globally unique across all phases when DAG mode is active.
   * Cycles and unknown ids are caught by `findInvariantViolations`.
   */
  dependsOn: z.array(idSchema).optional(),
});

export type RoutineStep = z.infer<typeof routineStepSchema>;

// ── Phases ─────────────────────────────────────────────────────────────────

/**
 * One ordered unit. All steps run in parallel; the phase completes when
 * every step has reported a result (or the first one fails, under
 * fail-fast). The reducer then composes a HandoffPayload from the step
 * results which becomes the next phase's `{{handoff.*}}` context.
 */
export const routinePhaseSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(routineStepSchema).min(1),
});

export type RoutinePhase = z.infer<typeof routinePhaseSchema>;

// ── Routine ────────────────────────────────────────────────────────────────

/**
 * Top-level template. Persisted as one JSON file at
 * `<projectPath>/.minions/routines/<id>.json`.
 */
export const routineSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** Schema version of the routine document. Bump when fields change shape. */
  version: z.literal(1).default(1),
  /** Inputs the user supplies at run time. */
  inputs: z.array(routineInputSchema).default([]),
  /** Ordered phases. At least one. */
  phases: z.array(routinePhaseSchema).min(1),
  /** v1 only accepts "fail-fast". Reserved for future expansion. */
  failurePolicy: z.literal("fail-fast").default("fail-fast"),
  /** Optional ISO timestamp for last edit; managed by the store. */
  updatedAt: z.string().optional(),
});

export type Routine = z.infer<typeof routineSchema>;

// ── Step / Phase results ───────────────────────────────────────────────────

/** Status a step ends in. The runtime uses this to gate phase advancement. */
export const stepOutcomeSchema = z.enum(["success", "error", "aborted"]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

/**
 * A structured artifact a step produced. Kept intentionally small so
 * artifacts travel cheaply in handoff payloads — large content should be
 * referenced by file path, not inlined.
 */
export const artifactSchema = z.object({
  /** Short, human-readable label ("design.md", "exa-results"). */
  label: z.string().min(1),
  /** Optional file path or URL. Preferred over inlining big content. */
  ref: z.string().optional(),
  /** Optional inline excerpt (kept short — guidance, not a transcript). */
  excerpt: z.string().optional(),
});
export type Artifact = z.infer<typeof artifactSchema>;

/** Result of one step. Produced by the step runner the scheduler is given. */
export const stepResultSchema = z.object({
  stepId: idSchema,
  /** What the step completed with. */
  outcome: stepOutcomeSchema,
  /** One-paragraph summary the agent reports at completion. */
  summary: z.string().default(""),
  /** Optional structured payload (key/value pairs the agent chose). */
  outputs: z.record(z.string(), z.unknown()).default({}),
  /** Optional artifacts. */
  artifacts: z.array(artifactSchema).default([]),
  /** Error message when outcome === "error". */
  error: z.string().optional(),
  /** Session key of the spawned Leader, if known. Used for UI links. */
  sessionKey: z.string().optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

/** Aggregated phase result before the reducer runs. */
export interface PhaseResult {
  phaseId: string;
  steps: StepResult[];
}

// ── Handoff payload ────────────────────────────────────────────────────────

/**
 * The structured context handed from one phase to the next. Templates in
 * the next phase reference these paths:
 *
 *   {{handoff.brief}}                  → the markdown brief
 *   {{handoff.facts.<key>}}            → reduced facts map
 *   {{handoff.steps.<stepId>.summary}} → individual step summaries
 *
 * The brief is the primary surface; facts and per-step summaries exist for
 * authors who want to address a specific upstream output by name.
 */
export const handoffPayloadSchema = z.object({
  fromPhaseId: idSchema,
  /**
   * The composed markdown brief. Generated by the reducer; enumerates each
   * step's task + summary + outputs and ends with consolidated context.
   */
  brief: z.string(),
  /** Reduced fact map addressable as {{handoff.facts.<key>}}. */
  facts: z.record(z.string(), z.unknown()).default({}),
  /** Per-step summaries indexed by stepId. */
  steps: z.record(
    z.string(),
    z.object({
      summary: z.string(),
      outcome: stepOutcomeSchema,
      outputs: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});

export type HandoffPayload = z.infer<typeof handoffPayloadSchema>;

// ── Run state (broadcast on the bus) ───────────────────────────────────────

/** Lifecycle states a Run progresses through. */
export const runStateSchema = z.enum([
  "pending", // accepted, not started
  "running", // a phase is in flight
  "success", // all phases completed successfully
  "error", // a phase failed; runtime aborted (fail-fast)
  "aborted", // the user cancelled
]);
export type RunState = z.infer<typeof runStateSchema>;

/** Per-phase status during a run. */
export const phaseRunStateSchema = z.enum([
  "pending",
  "running",
  "success",
  "error",
  "skipped",
]);
export type PhaseRunState = z.infer<typeof phaseRunStateSchema>;

/**
 * Per-step state emitted by the DAG scheduler. Contains the resolved
 * dependency edges so the UI can render a graph (visual graph is future work;
 * this PR emits the data).
 */
export const dagStepStateSchema = z.object({
  stepId: idSchema,
  label: z.string(),
  /** The phase this step was declared in (informational only in DAG mode). */
  phaseId: idSchema,
  /** Resolved dep ids — same as `step.dependsOn` at definition time. */
  dependsOn: z.array(idSchema).default([]),
  state: phaseRunStateSchema,
  sessionKey: z.string().optional(),
  outcome: stepOutcomeSchema.optional(),
  summary: z.string().optional(),
});
export type DagStepState = z.infer<typeof dagStepStateSchema>;

/**
 * Snapshot of a run pushed to the canvas via the bus. The RoutineNode
 * subscribes and re-renders. Kept compact — full step transcripts live
 * on the spawned Leader sessions, not in this snapshot.
 */
export const routineRunSnapshotSchema = z.object({
  runId: z.string(),
  routineId: idSchema,
  routineName: z.string(),
  state: runStateSchema,
  inputs: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
  phases: z.array(
    z.object({
      phaseId: idSchema,
      label: z.string(),
      state: phaseRunStateSchema,
      steps: z.array(
        z.object({
          stepId: idSchema,
          label: z.string(),
          sessionKey: z.string().optional(),
          outcome: stepOutcomeSchema.optional(),
          summary: z.string().optional(),
          /** Total attempts made for this step (1 = first try succeeded, N = N-1 retries). */
          attempts: z.number().optional(),
          /** Error message from the last failed attempt, if any. */
          lastError: z.string().optional(),
        }),
      ),
      handoff: handoffPayloadSchema.optional(),
    }),
  ),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
  /**
   * Execution mode discriminator. Absent (or "phases") means the classic
   * phase-barrier scheduler; "dag" means the DAG scheduler ran and
   * `dagSteps` is populated.
   */
  mode: z.enum(["phases", "dag"]).optional(),
  /**
   * Flat step states with resolved dependency edges. Populated only in
   * DAG mode. The UI uses this to render a step list / future graph view.
   */
  dagSteps: z.array(dagStepStateSchema).optional(),
});

export type RoutineRunSnapshot = z.infer<typeof routineRunSnapshotSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a Routine from an unknown JSON value. Throws on invalid input —
 * callers should `try`/`catch` and surface a structured error to the user.
 */
export function parseRoutine(value: unknown): Routine {
  return routineSchema.parse(value);
}

/**
 * Safe variant. Returns either the parsed routine or a list of error paths
 * suitable for surfacing in a UI without crashing.
 */
export function safeParseRoutine(
  value: unknown,
):
  | { ok: true; routine: Routine }
  | { ok: false; errors: { path: string; message: string }[] } {
  const result = routineSchema.safeParse(value);
  if (result.success) return { ok: true, routine: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

/**
 * A structural invariant violation that zod cannot express — used alongside
 * `findDuplicateIds` to surface DAG-mode errors at parse time.
 */
export interface InvariantViolation {
  /** Category of violation. */
  kind: "unknown-dep" | "cycle";
  /** Human-readable path for display (e.g. "step:my-step"). */
  path: string;
  /** Full description suitable for surfacing in a UI error list. */
  message: string;
}

/**
 * Validate DAG-mode invariants that zod cannot express:
 *   - dependsOn referencing unknown step ids (or ambiguous cross-phase ids)
 *   - dependency cycles
 *
 * Returns an empty array when the routine has no DAG steps (phases mode)
 * or when all DAG invariants hold.
 *
 * Run after `safeParseRoutine` and `findDuplicateIds`. Surface the union of
 * all returned violations in the same error list the editor renders.
 */
export function findInvariantViolations(
  routine: Routine,
): InvariantViolation[] {
  // Only activate when at least one step declares dependsOn.
  const hasDeps = routine.phases.some((p) =>
    p.steps.some((s) => (s.dependsOn?.length ?? 0) > 0),
  );
  if (!hasDeps) return [];

  const violations: InvariantViolation[] = [];

  // Build a count map: stepId -> number of phases it appears in.
  // In DAG mode step ids must be globally unique — ambiguous ids are
  // treated as unknown dependencies.
  const globalCount = new Map<string, number>();
  for (const phase of routine.phases) {
    for (const step of phase.steps) {
      globalCount.set(step.id, (globalCount.get(step.id) ?? 0) + 1);
    }
  }
  // Only uniquely-occurring ids are addressable by dependsOn.
  const knownIds = new Set<string>(
    [...globalCount.entries()].filter(([, c]) => c === 1).map(([id]) => id),
  );

  // Check that every dependsOn entry resolves to a known, unique step.
  const depsMap = new Map<string, string[]>();
  for (const phase of routine.phases) {
    for (const step of phase.steps) {
      const depList = step.dependsOn ?? [];
      depsMap.set(step.id, depList);
      for (const depId of depList) {
        if (!knownIds.has(depId)) {
          violations.push({
            kind: "unknown-dep",
            path: `step:${step.id}`,
            message: `step "${step.id}" has unknown dependency "${depId}"`,
          });
        }
      }
    }
  }

  // Cycle detection via Kahn's algorithm (topological sort).
  // Build in-degree + successor map using only known ids.
  const inDeg = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const id of knownIds) {
    inDeg.set(id, 0);
    successors.set(id, []);
  }
  for (const [id, deps] of depsMap) {
    if (!knownIds.has(id)) continue;
    let deg = 0;
    for (const dep of deps) {
      if (knownIds.has(dep)) {
        deg += 1;
        successors.get(dep)!.push(id);
      }
    }
    inDeg.set(id, deg);
  }

  const queue = [...knownIds].filter((id) => (inDeg.get(id) ?? 0) === 0);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed += 1;
    for (const succ of successors.get(id) ?? []) {
      const newDeg = (inDeg.get(succ) ?? 1) - 1;
      inDeg.set(succ, newDeg);
      if (newDeg === 0) queue.push(succ);
    }
  }

  if (processed < knownIds.size) {
    const cycleNodes = [...knownIds].filter((id) => (inDeg.get(id) ?? 0) > 0);
    violations.push({
      kind: "cycle",
      path: `steps:${cycleNodes.join(",")}`,
      message: `dependency cycle detected involving steps: ${cycleNodes.join(", ")}`,
    });
  }

  return violations;
}

/**
 * Walk a routine and surface duplicate ids — zod can't express "every
 * step.id unique within its phase, every phase.id unique within the
 * routine" in a single schema, so we run it as a structural check.
 */
export function findDuplicateIds(routine: Routine): string[] {
  const dups: string[] = [];
  const seenPhases = new Set<string>();
  for (const phase of routine.phases) {
    if (seenPhases.has(phase.id)) dups.push(`phase:${phase.id}`);
    seenPhases.add(phase.id);
    const seenSteps = new Set<string>();
    for (const step of phase.steps) {
      if (seenSteps.has(step.id)) dups.push(`step:${phase.id}/${step.id}`);
      seenSteps.add(step.id);
    }
  }
  const seenInputs = new Set<string>();
  for (const input of routine.inputs) {
    if (seenInputs.has(input.name)) dups.push(`input:${input.name}`);
    seenInputs.add(input.name);
  }
  return dups;
}
