import { buildLeaderSkillInventory } from "../../shared/leader-prompt.ts";
/**
 * Skill Template System
 *
 * Skills are markdown templates with {{placeholder}} variables.
 * Multiple skills can be tagged onto a Leader node and their
 * compiled markdown gets injected into the system prompt.
 */

import {
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
  /** Stable minions:<name> icon ID, legacy emoji, or custom text badge. */
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

export { buildSubskillMap, compileSkillTemplate, compileSkills } from "../../shared/skill-prompt.ts";

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
 * Build a markdown inventory of skills the Leader may "arm" a Minion
 * with via `assign_task`'s `skillIds` parameter. Lists each skill's
 * ID, name, and description so the LLM knows what's available without
 * the full template body. Returns empty string when there are no
 * skills in the library.
 */
export function buildArmingInventory(skills: SkillTemplate[]): string {
  return buildLeaderSkillInventory(skills);
}
