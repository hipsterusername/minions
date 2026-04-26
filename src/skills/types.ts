/**
 * Skill Template System
 *
 * Skills are markdown templates with {{placeholder}} variables.
 * Multiple skills can be tagged onto a Leader node and their
 * compiled markdown gets injected into the system prompt.
 */

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
    return `## Skill: ${skill.name}\n\n${compiled}`;
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
