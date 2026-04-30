/**
 * Routine context-path helpers.
 *
 * Pure functions that power the editor's context palette and prompt preview,
 * and the running view's "context bus" inspector. The single source of truth
 * for *what symbolic references are available at a given step* and *what a
 * given prompt actually consumes*.
 *
 * Design goals:
 *   - Mustache-only — `{{path}}` only, no expressions or conditionals.
 *   - Categorized — every entry carries a `kind` so the UI can colour-code
 *     and group without re-parsing.
 *   - Pre-run only — these helpers describe the *static* surface of a
 *     routine. Live values (run-time facts, real step outputs) layer on top
 *     in the running view; the palette categories stay the same shape.
 */
import type { Routine } from "../shared/routines/types.ts";

/** A reference kind. Drives colour and icon in the palette + preview. */
export type RefKind =
  | "input" //   {{inputs.<name>}}
  | "brief" //   {{handoff.brief}}
  | "summary" // {{handoff.steps.<id>.summary}}
  | "outcome" // {{handoff.steps.<id>.outcome}}
  | "outputs" // {{handoff.steps.<id>.outputs.*}}
  | "facts" //   {{handoff.facts.<key>}}
  | "unknown"; //  anything else, surfaced as a warning chip

/** A single reference token, exactly as it appears between `{{` and `}}`. */
export interface RefToken {
  /** The path between the braces ("inputs.topic" not "{{inputs.topic}}"). */
  path: string;
  kind: RefKind;
  /** Character offset of the opening `{{` in the source string. */
  start: number;
  /** Character offset of the character after the closing `}}`. */
  end: number;
}

/** A palette entry — what the user can drag/click into a prompt. */
export interface PaletteEntry {
  /** Path *without* braces. */
  path: string;
  kind: RefKind;
  /** Section this entry belongs to ("Inputs", phase label, etc.). */
  section: string;
  /** Short human label rendered in the chip ("topic", "step-1 summary"). */
  label: string;
  /** Source step id for kind="summary"|"outcome"|"outputs". */
  fromStepId?: string;
  /** Source phase id for handoff entries. */
  fromPhaseId?: string;
}

/** Grouped form for rendering in the palette. */
export interface PaletteSection {
  /** "Inputs" or a phase label. */
  title: string;
  /** Stable key for React lists. */
  key: string;
  entries: PaletteEntry[];
}

// ── classifyRef ─────────────────────────────────────────────────────────────

const PATH_RE = {
  input: /^inputs\.([a-zA-Z0-9_-]+)$/,
  brief: /^handoff\.brief$/,
  summary: /^handoff\.steps\.([a-zA-Z0-9_-]+)\.summary$/,
  outcome: /^handoff\.steps\.([a-zA-Z0-9_-]+)\.outcome$/,
  outputs: /^handoff\.steps\.([a-zA-Z0-9_-]+)\.outputs(?:\.[a-zA-Z0-9_.-]+)?$/,
  facts: /^handoff\.facts\.[a-zA-Z0-9_.-]+$/,
} as const;

/**
 * Classify a path token (no braces). Returns "unknown" for anything that
 * doesn't match a documented schema — the UI surfaces these as warnings.
 */
export function classifyRef(path: string): RefKind {
  if (PATH_RE.input.test(path)) return "input";
  if (PATH_RE.brief.test(path)) return "brief";
  if (PATH_RE.summary.test(path)) return "summary";
  if (PATH_RE.outcome.test(path)) return "outcome";
  if (PATH_RE.outputs.test(path)) return "outputs";
  if (PATH_RE.facts.test(path)) return "facts";
  return "unknown";
}

// ── extractRefs ─────────────────────────────────────────────────────────────

/**
 * Walk a string and emit one RefToken per `{{path}}` it finds. The path is
 * trimmed; whitespace inside the braces is ignored. Mustache nestings (`{{{`)
 * are not part of the routine grammar — three open braces still yields one
 * ref starting at the second one to keep the editor forgiving.
 */
export function extractRefs(text: string): RefToken[] {
  const tokens: RefToken[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const path = match[1] ?? "";
    tokens.push({
      path,
      kind: classifyRef(path),
      start: match.index,
      end: match.index + match[0].length,
    });
    match = re.exec(text);
  }
  return tokens;
}

// ── buildPaletteSections ────────────────────────────────────────────────────

/**
 * Compose the categorized palette for the step at (phaseIdx, *). Entries
 * are organised by source: inputs first, then one section per upstream phase.
 *
 * Phase N can reference:
 *   - any declared input
 *   - {{handoff.brief}} for the *immediately previous* phase only — the
 *     scheduler hands one HandoffPayload at a time
 *   - {{handoff.steps.<id>.summary|outcome|outputs}} for any step that
 *     belongs to the immediately previous phase
 *   - {{handoff.facts.<key>}} surfaces *cumulative* facts the reducer
 *     accumulates across phases — exposed as a single "Facts" section
 *
 * The palette mirrors that contract: the only "From phase X" section
 * surfaced is `phaseIdx - 1`. We still emit a Facts section because
 * authors can address cumulative facts by key.
 */
export function buildPaletteSections(
  routine: Routine,
  phaseIdx: number,
): PaletteSection[] {
  const sections: PaletteSection[] = [];

  // 1. Inputs
  const inputEntries: PaletteEntry[] = routine.inputs
    .filter((i) => i.name.length > 0)
    .map((i) => ({
      path: `inputs.${i.name}`,
      kind: "input" as const,
      section: "Inputs",
      label: i.label || i.name,
    }));
  if (inputEntries.length > 0) {
    sections.push({ title: "Inputs", key: "inputs", entries: inputEntries });
  }

  // 2. Handoff from the immediately previous phase
  if (phaseIdx > 0) {
    const prev = routine.phases[phaseIdx - 1];
    if (prev) {
      const prevEntries: PaletteEntry[] = [
        {
          path: "handoff.brief",
          kind: "brief",
          section: prev.label,
          label: "phase brief",
          fromPhaseId: prev.id,
        },
      ];
      for (const step of prev.steps) {
        prevEntries.push(
          {
            path: `handoff.steps.${step.id}.summary`,
            kind: "summary",
            section: prev.label,
            label: `${step.label} · summary`,
            fromStepId: step.id,
            fromPhaseId: prev.id,
          },
          {
            path: `handoff.steps.${step.id}.outcome`,
            kind: "outcome",
            section: prev.label,
            label: `${step.label} · outcome`,
            fromStepId: step.id,
            fromPhaseId: prev.id,
          },
          {
            path: `handoff.steps.${step.id}.outputs`,
            kind: "outputs",
            section: prev.label,
            label: `${step.label} · outputs`,
            fromStepId: step.id,
            fromPhaseId: prev.id,
          },
        );
      }
      sections.push({
        title: prev.label,
        key: `phase-${prev.id}`,
        entries: prevEntries,
      });
    }
  }

  return sections;
}

// ── reverseLookup ──────────────────────────────────────────────────────────

/** Map of `path → count` describing what a prompt actually uses. */
export type RefUsage = ReadonlyMap<string, number>;

/**
 * Tally references in a prompt. Drives the "(used 2×)" badge in the palette
 * and the "unused inputs" warning in the flow map.
 */
export function tallyUsage(text: string): RefUsage {
  const counts = new Map<string, number>();
  for (const tok of extractRefs(text)) {
    counts.set(tok.path, (counts.get(tok.path) ?? 0) + 1);
  }
  return counts;
}

/**
 * Consolidated audit for a routine. Surfaces:
 *   - inputs declared but never referenced anywhere
 *   - prompt refs that don't resolve to any palette entry (typos, drift)
 *
 * Used by the editor's flow map and the validation summary.
 */
export interface RoutineRefAudit {
  unusedInputs: string[];
  unknownRefs: { path: string; phaseId: string; stepId: string }[];
}

export function auditRoutineRefs(routine: Routine): RoutineRefAudit {
  const allUsed = new Set<string>();
  const unknownRefs: RoutineRefAudit["unknownRefs"] = [];

  routine.phases.forEach((phase, pIdx) => {
    const sections = buildPaletteSections(routine, pIdx);
    const known = new Set<string>();
    for (const sec of sections) {
      for (const e of sec.entries) {
        // Outputs is a wildcard root — match {{handoff.steps.x.outputs.*}}.
        if (e.kind === "outputs") {
          known.add(e.path); // exact form
        } else {
          known.add(e.path);
        }
      }
    }
    for (const step of phase.steps) {
      const promptRefs = extractRefs(step.routinePrompt);
      const sysRefs = step.systemPrompt ? extractRefs(step.systemPrompt) : [];
      for (const ref of [...promptRefs, ...sysRefs]) {
        allUsed.add(ref.path);
        // Inputs always known if declared; checked via classifyRef + match.
        if (ref.kind === "unknown") {
          unknownRefs.push({
            path: ref.path,
            phaseId: phase.id,
            stepId: step.id,
          });
          continue;
        }
        if (ref.kind === "input") {
          const name = ref.path.slice("inputs.".length);
          if (!routine.inputs.some((i) => i.name === name)) {
            unknownRefs.push({
              path: ref.path,
              phaseId: phase.id,
              stepId: step.id,
            });
          }
          continue;
        }
        if (ref.kind === "outputs") {
          // {{handoff.steps.<id>.outputs.<key>}} is a typed key drill-down;
          // count the outputs root as used.
          const outputsRoot = ref.path.split(".").slice(0, 4).join(".");
          if (!known.has(outputsRoot)) {
            unknownRefs.push({
              path: ref.path,
              phaseId: phase.id,
              stepId: step.id,
            });
          }
          continue;
        }
        // Facts is wildcard — accept any key, but only after the first phase.
        if (ref.kind === "facts" && pIdx === 0) {
          unknownRefs.push({
            path: ref.path,
            phaseId: phase.id,
            stepId: step.id,
          });
          continue;
        }
        // Brief/summary/outcome must resolve to an exact palette entry.
        if (
          (ref.kind === "brief" ||
            ref.kind === "summary" ||
            ref.kind === "outcome") &&
          !known.has(ref.path)
        ) {
          unknownRefs.push({
            path: ref.path,
            phaseId: phase.id,
            stepId: step.id,
          });
        }
      }
    }
  });

  const unusedInputs = routine.inputs
    .map((i) => i.name)
    .filter((n) => n && !allUsed.has(`inputs.${n}`));

  return { unusedInputs, unknownRefs };
}
