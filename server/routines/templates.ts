/**
 * Built-in routine templates.
 *
 * Routines are stored per-project as JSON files under
 * `.claude-canvas/routines/`, but `.claude-canvas/` is gitignored — so
 * shareable starter routines have to live as code that the project store
 * can seed into a fresh sidecar on demand.
 *
 * Phase A ships one starter that mirrors the "source context → analyze
 * → report" workflow the user described. Phase B's UI will surface a
 * "Seed from template" affordance that invokes `seedTemplate(...)`.
 */

import { saveRoutine } from "../routine-store.ts";
import {
  parseRoutine,
  type Routine,
} from "../../shared/routines/types.ts";

/**
 * Domain context → analysis → report.
 *
 * Three phases. Phase 1 parallelises web-search and repo-grep style
 * sourcing. Phase 2 synthesizes into a single brief. Phase 3 writes a
 * report from the brief. Skill / MCP wiring is left as a stub — the
 * scheduler accepts those fields today but they activate when Phase B's
 * spawn implementation lands.
 */
export const RESEARCH_ANALYZE_REPORT: Routine = parseRoutine({
  id: "research-analyze-report",
  name: "Research → Analyze → Report",
  description:
    "Source context on a topic from external + internal sources, " +
    "synthesize the findings into a single brief, then generate a report.",
  inputs: [
    {
      name: "topic",
      label: "Topic",
      description: "The subject to research.",
      required: true,
    },
    {
      name: "audience",
      label: "Audience",
      description: "Who the final report is for.",
      required: false,
      defaultValue: "engineering leadership",
    },
  ],
  phases: [
    {
      id: "source",
      label: "Source context",
      description:
        "Pull background context from the open web and from any project " +
        "knowledge already on disk. Parallel — neither agent depends on " +
        "the other.",
      steps: [
        {
          id: "external",
          label: "External sources",
          routinePrompt:
            "Research **{{inputs.topic}}** from authoritative external " +
            "sources. Identify the key sub-topics, current consensus, and " +
            "any active debates. Report a concise summary plus structured " +
            "outputs: `sourceCount`, `topSources` (array of urls), " +
            "`subTopics` (array). When you finish, call `report_phase_result` " +
            "(or, if that tool is not available in this build, end your " +
            "final assistant turn with a single fenced ```json block " +
            "containing your summary and outputs).",
        },
        {
          id: "internal",
          label: "Internal sources",
          routinePrompt:
            "Search the current project for prior knowledge of " +
            "**{{inputs.topic}}**. Prefer Glob+Grep over reading whole " +
            "trees. Report a concise summary plus structured outputs: " +
            "`fileMatches` (array of paths), `priorWorkFound` (boolean).",
        },
      ],
    },
    {
      id: "analyze",
      label: "Analyze",
      description: "Synthesize the parallel sources into a single brief.",
      steps: [
        {
          id: "synthesize",
          label: "Synthesize",
          routinePrompt:
            "You have just received the following handoff from the source " +
            "phase:\n\n{{handoff.brief}}\n\nProduce a synthesized analysis " +
            "of **{{inputs.topic}}** intended for {{inputs.audience}}. " +
            "Reconcile any disagreement between external and internal " +
            "sources, call out gaps, and end with a 5-bullet summary.",
        },
      ],
    },
    {
      id: "report",
      label: "Report",
      description: "Write the final report from the analysis brief.",
      steps: [
        {
          id: "write",
          label: "Write report",
          routinePrompt:
            "Using the analysis brief below, write a final report on " +
            "**{{inputs.topic}}** addressed to {{inputs.audience}}. " +
            "Markdown. Sections: Background, Findings, Risks, " +
            "Recommendations.\n\n## Analysis brief\n{{handoff.brief}}",
        },
      ],
    },
  ],
});

/** Every built-in routine, in display order for the seeder UI. */
export const BUILT_IN_ROUTINES: readonly Routine[] = [
  RESEARCH_ANALYZE_REPORT,
];

/** Look up a built-in routine by id. */
export function getBuiltInRoutine(id: string): Routine | undefined {
  return BUILT_IN_ROUTINES.find((r) => r.id === id);
}

/**
 * Copy a built-in routine into the project's sidecar so the user can edit
 * it. Throws if the id is unknown. Returns the saved routine (with
 * updatedAt stamped).
 */
export function seedBuiltInRoutine(
  projectPath: string,
  id: string,
): Routine {
  const tmpl = getBuiltInRoutine(id);
  if (!tmpl) throw new Error(`Unknown built-in routine: ${id}`);
  return saveRoutine(projectPath, tmpl);
}
