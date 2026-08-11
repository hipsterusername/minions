/**
 * Skill Template System
 *
 * Skills are markdown templates with {{placeholder}} variables.
 * Multiple skills can be tagged onto a Leader node and their
 * compiled markdown gets injected into the system prompt.
 */

import {
  formatSkillAttachments,
  type SkillAttachment,
} from "../../shared/skill-attachments.ts";

export type { SkillAttachment } from "../../shared/skill-attachments.ts";

/** A variable extracted from {{name}} patterns in the template */
export interface SkillVariable {
  /** Variable name (extracted from {{name}} in the template) */
  name: string;
  /** Human-readable label for the input field */
  label: string;
  /** Input type for the UI */
  type: "text" | "textarea" | "select";
  /** Placeholder text for input fields */
  placeholder?: string;
  /** Whether this variable must be filled before running */
  required?: boolean;
  /** Default value */
  defaultValue?: string;
  /** Options for select type */
  options?: { value: string; label: string }[];
  /** Help text shown below the input */
  description?: string;
}

/**
 * A sub-skill nested inside a parent {@link SkillTemplate}. The parent's
 * compiled prompt always injects a *map* of its sub-skills (name +
 * when-to-use + description); the full `body` is pulled on demand via the
 * `load_subskill` tool unless `alwaysInclude` eagerly inlines it.
 */
export interface SubSkill {
  /** Auto-generated from the name in the editor */
  id: string;
  /** Display name */
  name: string;
  /** One-line summary shown in the map */
  description: string;
  /** Full content, pulled on demand (or eager-inlined when alwaysInclude) */
  body: string;
  /** Trigger hint shown in the map so an agent knows when to load it */
  whenToUse?: string;
  /** Eager-inline the body into the parent prompt instead of on-demand */
  alwaysInclude?: boolean;
  /** Frozen text files/context loaded with this sub-skill. */
  attachments?: SkillAttachment[];
}

export interface SkillTemplate {
  /** Unique skill identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description shown in skill browser/tags */
  description: string;
  /** Category for grouping */
  category: "code" | "docs" | "testing" | "devops" | "analysis" | "design" | "general";
  /** Emoji icon */
  icon: string;
  /** Accent color hex for UI */
  accentColor: string;
  /**
   * The markdown template content. Uses {{variable_name}} placeholders.
   * When compiled, placeholders are replaced with user-provided values.
   * If a placeholder has no value, it's replaced with empty string.
   */
  template: string;
  /**
   * Variable definitions for the placeholders in the template.
   * These define how the UI renders input fields for each variable.
   * Variables not listed here but present as {{name}} in the template
   * get a default text input.
   */
  variables: SkillVariable[];
  /** Frozen text files/context included whenever this skill is active. */
  attachments?: SkillAttachment[];
  /**
   * Optional nested sub-skills. Stored inline (one level only). The parent's
   * compiled prompt injects a map of these; bodies are pulled on demand.
   */
  subskills?: SubSkill[];
  /**
   * True for read-only, code-authored built-in presets (bridged from
   * `shared/skill-presets.ts`). These are pickable/taggable but never written
   * to the project's `.minions/skills.json` and cannot be deleted from the UI.
   * Editing one creates a project override (a normal, persisted copy).
   */
  builtIn?: boolean;
}

/**
 * Build the always-injected *map* of a skill's sub-skills: a compact list of
 * each sub-skill's id/name/description (+ when-to-use), an instruction to pull
 * a body on demand via `load_subskill`, and eager-inlined bodies for any
 * sub-skill flagged `alwaysInclude`. Returns `""` when the skill has none.
 */
export function buildSubskillMap(skill: SkillTemplate): string {
  const subskills = skill.subskills ?? [];
  if (subskills.length === 0) return "";

  const bullets = subskills.map((sub) => {
    const desc = sub.description?.trim() || "(no description)";
    const when = sub.whenToUse?.trim()
      ? ` When to use: ${sub.whenToUse.trim()}`
      : "";
    const loaded = sub.alwaysInclude ? " (loaded below)" : "";
    return `- \`${sub.id}\` — **${sub.name}**: ${desc}.${when}${loaded}`;
  });

  const eager = subskills
    .filter((sub) => sub.alwaysInclude)
    .map((sub) => {
      const attachments = formatSkillAttachments(
        sub.attachments,
        `Attached context for ${sub.name}`,
      );
      return `#### ${sub.name}\n\n${sub.body.trim()}`
        + (attachments ? `\n\n${attachments}` : "");
    });

  const parts = [
    `### Sub-skills of ${skill.name}`,
    `This skill is a map. The sub-skills below are not loaded by default. ` +
      `To pull one into context, call \`load_subskill\` with ` +
      `\`skillId: "${skill.id}"\` and the sub-skill's id.`,
    bullets.join("\n"),
  ];
  if (eager.length > 0) parts.push(eager.join("\n\n"));
  return parts.join("\n\n");
}

/**
 * Compile a skill template by replacing {{placeholders}} with values.
 * Returns the compiled markdown string.
 */
export function compileSkillTemplate(
  skill: SkillTemplate,
  values: Record<string, string>,
): string {
  let result = skill.template;
  // Replace all {{variable_name}} with their values (or empty string)
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    return values[name] ?? "";
  });
  // Clean up any leftover empty lines from missing optional variables
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Extract variable names from a template string.
 * Returns unique variable names found as {{name}} patterns.
 */
export function extractVariableNames(template: string): string[] {
  const names = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let match;
  while ((match = re.exec(template)) !== null) {
    names.add(match[1]!);
  }
  return Array.from(names);
}

/**
 * Compile multiple skill templates and join them into a single
 * system prompt addendum. Each skill's output is wrapped in a section.
 */
export function compileSkills(
  skills: SkillTemplate[],
  allValues: Record<string, Record<string, string>>,
): string {
  if (skills.length === 0) return "";

  const sections = skills.map((skill) => {
    const values = allValues[skill.id] ?? {};
    const compiled = compileSkillTemplate(skill, values);
    const attachments = formatSkillAttachments(
      skill.attachments,
      `Attached context for ${skill.name}`,
    );
    const map = buildSubskillMap(skill);
    return `## Skill: ${skill.name}\n\n${compiled}`
      + (attachments ? `\n\n${attachments}` : "")
      + (map ? `\n\n${map}` : "");
  });

  return `\n\n# Active Skills\n\nThe following skills are active for this session. Follow their instructions.\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * Build a markdown inventory of skills the Leader may "arm" a Minion
 * with via `assign_task`'s `skillIds` parameter. Lists each skill's
 * ID, name, and description so the LLM knows what's available without
 * the full template body. Returns empty string when there are no
 * skills in the library.
 */
export function buildArmingInventory(skills: SkillTemplate[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const desc = s.description?.trim() || "(no description)";
    return `- \`${s.id}\` — **${s.name}**: ${desc}`;
  });
  return (
    `\n\n# Available Skills (for arming Minions)\n\n` +
    `When delegating with \`assign_task\`, you may pass \`skillIds\` to ` +
    `arm the Minion with one or more of the skills below. The compiled ` +
    `skill instructions will be appended to the Minion's system prompt. ` +
    `Use this when a task needs focused expertise (e.g. lint cleanup, ` +
    `code review, doc writing). Pass \`skillValues\` only for skills ` +
    `whose templates have \`{{placeholders}}\`.\n\n` +
    `${lines.join("\n")}`
  );
}
