/**
 * Routine prompt templating.
 *
 * Mustache-flavour `{{path}}` substitution against a typed context bag.
 * Deliberately constrained — no expressions, no conditionals — so prompt
 * authors can't accidentally hide work behind a templating language.
 *
 * Resolvable paths
 * ────────────────
 *   {{inputs.<name>}}                      routine input value
 *   {{handoff.brief}}                      prior phase's composed markdown
 *   {{handoff.facts.<step>.<key>}}         reduced fact (already namespaced)
 *   {{handoff.steps.<step>.summary}}       prior step summary
 *   {{handoff.steps.<step>.outcome}}       prior step outcome
 *   {{depends.<stepId>.summary}}           DAG: dep step summary
 *   {{depends.<stepId>.outcome}}           DAG: dep step outcome
 *   {{depends.facts.<stepId>.<key>}}       DAG: dep step output value
 *   {{phase.id}} / {{phase.label}}         metadata for the current phase
 *   {{step.id}} / {{step.label}}           metadata for the current step
 *
 * The `depends.*` paths are populated only in DAG mode (when a step declares
 * `dependsOn`). `handoff.*` paths are populated only in phases mode.
 *
 * Behavior on misses
 * ──────────────────
 *   - Unknown paths render as empty strings AND are surfaced in the
 *     `unresolved` array so callers can warn the user. Failing loudly
 *     during a long-running routine is worse than rendering an empty
 *     stub the agent can react to ("the prior phase produced no X").
 */

import type {
  HandoffPayload,
  RoutineInputValues,
} from "../../shared/routines/types.ts";

/** Per-dep step entry available via `{{depends.<stepId>.*}}` in DAG mode. */
export interface DependsStepEntry {
  summary: string;
  outcome: string;
  outputs: Record<string, unknown>;
}

/**
 * Context scoped to a step's declared `dependsOn` set in DAG mode.
 * Populated by `buildDependsContext` in handoff.ts.
 */
export interface DependsContext {
  /** Per-dep step entries keyed by stepId. */
  steps: Record<string, DependsStepEntry>;
  /** Flat fact map keyed as "stepId.key" for `{{depends.facts.*}}`. */
  facts: Record<string, unknown>;
}

export interface TemplateContext {
  inputs: RoutineInputValues;
  handoff?: HandoffPayload;
  /** DAG mode: results of declared dep steps, scoped to this step's deps. */
  depends?: DependsContext;
  phase?: { id: string; label: string };
  step?: { id: string; label: string };
}

export interface RenderedTemplate {
  text: string;
  unresolved: string[];
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Render a template string against the given context. Pure function —
 * does not mutate the context.
 */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
): RenderedTemplate {
  const unresolved: string[] = [];
  const text = template.replace(PLACEHOLDER, (_match, raw: string) => {
    const path = raw.trim();
    const value = resolve(path, ctx);
    if (value === undefined) {
      unresolved.push(path);
      return "";
    }
    return formatValue(value);
  });
  return { text, unresolved };
}

function resolve(path: string, ctx: TemplateContext): unknown {
  const parts = path.split(".");
  const head = parts[0];
  const rest = parts.slice(1);
  switch (head) {
    case "inputs":
      return rest.length === 1 ? ctx.inputs[rest[0]!] : undefined;
    case "handoff":
      if (!ctx.handoff) return undefined;
      return resolveHandoff(rest, ctx.handoff);
    case "phase":
      if (!ctx.phase) return undefined;
      if (rest.length !== 1) return undefined;
      if (rest[0] === "id") return ctx.phase.id;
      if (rest[0] === "label") return ctx.phase.label;
      return undefined;
    case "step":
      if (!ctx.step) return undefined;
      if (rest.length !== 1) return undefined;
      if (rest[0] === "id") return ctx.step.id;
      if (rest[0] === "label") return ctx.step.label;
      return undefined;
    case "depends":
      if (!ctx.depends) return undefined;
      return resolveDepends(rest, ctx.depends);
    default:
      return undefined;
  }
}

function resolveDepends(parts: string[], ctx: DependsContext): unknown {
  if (parts.length === 0) return undefined;
  const head = parts[0]!;
  const rest = parts.slice(1);
  // {{depends.facts.<stepId>.<key>}} — flat fact map keyed as "stepId.key"
  if (head === "facts") {
    if (rest.length === 0) return undefined;
    const joinedKey = rest.join(".");
    if (Object.prototype.hasOwnProperty.call(ctx.facts, joinedKey)) {
      return ctx.facts[joinedKey];
    }
    return undefined;
  }
  // {{depends.<stepId>.summary}} or {{depends.<stepId>.outcome}}
  const stepEntry = ctx.steps[head];
  if (!stepEntry) return undefined;
  if (rest.length !== 1) return undefined;
  if (rest[0] === "summary") return stepEntry.summary;
  if (rest[0] === "outcome") return stepEntry.outcome;
  return undefined;
}

function resolveHandoff(parts: string[], handoff: HandoffPayload): unknown {
  if (parts.length === 0) return undefined;
  const head = parts[0];
  const rest = parts.slice(1);
  if (head === "brief") return rest.length === 0 ? handoff.brief : undefined;
  if (head === "facts") {
    if (rest.length === 0) return undefined;
    // facts are flat with already-namespaced keys ("stepId.key").
    // Allow either {{handoff.facts.step.key}} or {{handoff.facts.step}}.
    const joinedKey = rest.join(".");
    if (Object.prototype.hasOwnProperty.call(handoff.facts, joinedKey)) {
      return handoff.facts[joinedKey];
    }
    return undefined;
  }
  if (head === "steps") {
    if (rest.length !== 2) return undefined;
    const stepEntry = handoff.steps[rest[0]!];
    if (!stepEntry) return undefined;
    if (rest[1] === "summary") return stepEntry.summary;
    if (rest[1] === "outcome") return stepEntry.outcome;
    return undefined;
  }
  return undefined;
}

function formatValue(v: unknown): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
