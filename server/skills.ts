/**
 * Server-side skill loading and compilation.
 *
 * Mirrors the pure helpers in `src/skills/types.ts`. We re-implement here
 * rather than importing from `src/` because the architecture suite forbids
 * cross-tree imports (see tests/architecture/no-cross-tree-imports.test.ts).
 *
 * Skills live in each project's sidecar at `.claude-canvas/skills.json`
 * and are written by the frontend via `writeSkills()` in `project-store.ts`.
 * The Leader's `assign_task` tool uses these helpers to "arm" a Minion
 * with one or more skills, appending the compiled markdown to that
 * Minion's system prompt.
 */

import { readSkills } from "./project-store.ts";

/** Variable definition extracted from {{name}} patterns in a template. */
export interface SkillVariable {
  name: string;
  label: string;
  type: "text" | "textarea" | "select";
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  description?: string;
}

/** A skill template loaded from `.claude-canvas/skills.json`. */
export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  category:
    | "code"
    | "docs"
    | "testing"
    | "devops"
    | "analysis"
    | "design"
    | "general";
  icon: string;
  accentColor: string;
  template: string;
  variables: SkillVariable[];
}

/**
 * Compile a single skill template by replacing every `{{variable}}`
 * placeholder with the matching value (or empty string).
 */
export function compileSkillTemplate(
  skill: SkillTemplate,
  values: Record<string, string>,
): string {
  let result = skill.template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, name: string) => values[name] ?? "",
  );
  // Collapse runs of blank lines left behind by missing optional values.
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Compile a list of skills into a single Markdown addendum, suitable
 * for appending to an agent's system prompt.
 */
export function compileSkills(
  skills: SkillTemplate[],
  allValues: Record<string, Record<string, string>>,
): string {
  if (skills.length === 0) return "";
  const sections = skills.map((skill) => {
    const values = allValues[skill.id] ?? {};
    const compiled = compileSkillTemplate(skill, values);
    return `## Skill: ${skill.name}\n\n${compiled}`;
  });
  return (
    `\n\n# Active Skills\n\n` +
    `The following skills are active for this session. ` +
    `Follow their instructions.\n\n` +
    sections.join("\n\n---\n\n")
  );
}

/**
 * Lightweight runtime guard for entries pulled from `skills.json`.
 * Skips entries that do not look like a skill so a malformed file
 * cannot poison the system prompt.
 */
function isSkillTemplate(value: unknown): value is SkillTemplate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["template"] === "string"
  );
}

/**
 * Load every skill defined in the project's sidecar `skills.json`.
 * Returns an empty array when the file is missing or malformed.
 */
export function loadAllSkills(projectPath: string): SkillTemplate[] {
  const raw = readSkills(projectPath);
  return raw.filter(isSkillTemplate);
}

/**
 * Load skills by ID from the project's sidecar. Unknown IDs are silently
 * skipped — the caller (the Leader LLM) may have hallucinated a skill
 * name and we don't want to abort delegation over it.
 */
export function loadSkillsByIds(
  projectPath: string,
  ids: readonly string[],
): SkillTemplate[] {
  if (ids.length === 0) return [];
  const all = loadAllSkills(projectPath);
  const byId = new Map(all.map((s) => [s.id, s] as const));
  const out: SkillTemplate[] = [];
  for (const id of ids) {
    const skill = byId.get(id);
    if (skill) out.push(skill);
  }
  return out;
}
