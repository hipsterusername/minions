/**
 * Phase handoff reducer.
 *
 * Takes the raw `PhaseResult` (one entry per step) and produces a typed
 * `HandoffPayload` that the next phase's step prompts can address via
 * `{{handoff.brief}}`, `{{handoff.facts.x}}`, and `{{handoff.steps.id.summary}}`.
 *
 * Why a dedicated reducer
 * ───────────────────────
 *   - Without a reducer, "what does the next agent see from the prior
 *     phase?" defaults to "the full transcript" — which blows context fast.
 *   - The reducer is the back-pressure mechanism: every step must report a
 *     summary + structured outputs at completion. The brief is composed
 *     deterministically, never the entire transcript.
 *
 * v1 reducer kinds
 * ────────────────
 *   "structured-enumeration" (default) — Composes a markdown brief that
 *     enumerates each step (label, task, summary, outputs, artifacts) and
 *     ends with a "shared context" note. Pure function, no LLM call.
 *
 *   LLM-based reducers and JSONPath pluck modes are deliberately out of
 *     scope for v1 (cost + complexity, easy to add later behind the same
 *     `reduce(...)` entry point).
 */

import type {
  HandoffPayload,
  PhaseResult,
  RoutineInputValues,
  RoutinePhase,
  StepResult,
} from "../../shared/routines/types.ts";
import type { DependsContext } from "./template.ts";

/** Inputs to the reducer. Keeps the call site explicit. */
export interface ReduceArgs {
  phase: RoutinePhase;
  result: PhaseResult;
  /** Original routine inputs — surfaced in the brief header for context. */
  inputs: RoutineInputValues;
}

/**
 * Reduce a phase result into a HandoffPayload. Pure function — same input
 * always yields the same output. Step ordering in the brief mirrors the
 * declared step order in the phase, not the completion order.
 */
export function reducePhase({
  phase,
  result,
  inputs,
}: ReduceArgs): HandoffPayload {
  const stepsByDeclaredOrder = phase.steps.map((step) => {
    const found = result.steps.find((s) => s.stepId === step.id);
    if (!found) {
      throw new Error(
        `Phase reducer: missing result for step "${step.id}" in phase "${phase.id}"`,
      );
    }
    return { step, result: found };
  });

  const brief = composeBrief({
    phase,
    inputs,
    pairs: stepsByDeclaredOrder,
  });

  // facts: union of every step's outputs, prefixed by stepId so authors can
  // address them unambiguously even when two steps choose the same key.
  const facts: Record<string, unknown> = {};
  for (const { step, result: r } of stepsByDeclaredOrder) {
    for (const [k, v] of Object.entries(r.outputs)) {
      facts[`${step.id}.${k}`] = v;
    }
  }

  // steps: per-step summary keyed by stepId for direct addressing.
  const steps: HandoffPayload["steps"] = {};
  for (const { step, result: r } of stepsByDeclaredOrder) {
    steps[step.id] = {
      summary: r.summary,
      outcome: r.outcome,
      outputs: r.outputs,
    };
  }

  return {
    fromPhaseId: phase.id,
    brief,
    facts,
    steps,
  };
}

interface ComposeBriefArgs {
  phase: RoutinePhase;
  inputs: RoutineInputValues;
  pairs: { step: RoutinePhase["steps"][number]; result: StepResult }[];
}

/**
 * Render the markdown brief. Format is intentionally rigid so prompts in
 * the next phase can reliably point the agent at known sections.
 *
 * Structure:
 *
 *   # Handoff from phase: <label>
 *   _<phase description>_
 *
 *   ## Inputs
 *   - <name>: <value>
 *
 *   ## Agent outputs
 *   ### <step.label> (`step.id`)
 *   **Task:** <one-line task instruction summary>
 *   **Outcome:** success | error | aborted
 *   **Summary:** <agent-reported summary>
 *   **Outputs:**
 *   - <key>: <value>
 *   **Artifacts:**
 *   - <label> — `<ref>`
 *     > <excerpt>
 *
 *   ## Shared context
 *   The following information was established by phase "<id>" and should
 *   inform every step in the next phase: ...
 */
function composeBrief({ phase, inputs, pairs }: ComposeBriefArgs): string {
  const lines: string[] = [];
  lines.push(`# Handoff from phase: ${phase.label}`);
  if (phase.description) lines.push(`_${phase.description}_`);
  lines.push("");

  const inputEntries = Object.entries(inputs);
  if (inputEntries.length > 0) {
    lines.push("## Inputs");
    for (const [k, v] of inputEntries) {
      lines.push(`- **${k}:** ${formatValue(v)}`);
    }
    lines.push("");
  }

  lines.push("## Agent outputs");
  for (const { step, result } of pairs) {
    lines.push("");
    lines.push(`### ${step.label} (\`${step.id}\`)`);
    lines.push(`**Task:** ${oneLine(step.routinePrompt)}`);
    lines.push(`**Outcome:** ${result.outcome}`);
    if (result.summary.trim()) {
      lines.push(`**Summary:** ${oneLine(result.summary)}`);
    } else {
      lines.push("**Summary:** _(no summary reported)_");
    }
    const outputEntries = Object.entries(result.outputs);
    if (outputEntries.length > 0) {
      lines.push("**Outputs:**");
      for (const [k, v] of outputEntries) {
        lines.push(`- \`${k}\`: ${formatValue(v)}`);
      }
    }
    if (result.artifacts.length > 0) {
      lines.push("**Artifacts:**");
      for (const a of result.artifacts) {
        const ref = a.ref ? ` — \`${a.ref}\`` : "";
        lines.push(`- ${a.label}${ref}`);
        if (a.excerpt) lines.push(`  > ${oneLine(a.excerpt)}`);
      }
    }
    if (result.outcome === "error" && result.error) {
      lines.push(`**Error:** ${oneLine(result.error)}`);
    }
  }

  lines.push("");
  lines.push("## Shared context");
  lines.push(
    `The information above was produced by phase \`${phase.id}\`. Treat ` +
      `the agent summaries and outputs as the authoritative ground truth ` +
      `from this phase; do not re-do work that has already been completed. ` +
      `Reference specific outputs with \`{{handoff.facts.<stepId>.<key>}}\` ` +
      `or \`{{handoff.steps.<stepId>.summary}}\` when you need to point ` +
      `the next agent at one piece in particular.`,
  );

  return lines.join("\n");
}

/** Collapse a multi-line string to a single line for inline rendering. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Render a primitive or JSON value compactly for the brief. */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "_(none)_";
  if (typeof v === "string") return oneLine(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return "`" + JSON.stringify(v) + "`";
  } catch {
    return String(v);
  }
}

/**
 * Build a `DependsContext` scoped to one step's declared `dependsOn` set.
 *
 * Only the dep ids listed in `depIds` are included — sibling steps that
 * the current step did not declare a dependency on are excluded.
 *
 * Used by the DAG scheduler to populate `{{depends.*}}` template paths.
 */
export function buildDependsContext(
  depIds: readonly string[],
  resultsByStepId: ReadonlyMap<string, StepResult>,
): DependsContext {
  const steps: DependsContext["steps"] = {};
  const facts: Record<string, unknown> = {};

  for (const depId of depIds) {
    const result = resultsByStepId.get(depId);
    if (!result) continue;
    steps[depId] = {
      summary: result.summary,
      outcome: result.outcome,
      outputs: result.outputs,
    };
    for (const [k, v] of Object.entries(result.outputs)) {
      facts[`${depId}.${k}`] = v;
    }
  }

  return { steps, facts };
}
