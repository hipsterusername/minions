/** Server-side library loading. The shared compiler keeps preview and all agent paths aligned. */

import { readSkills } from "./project-store.ts";
import { builtInSkillPresets } from "../shared/skill-presets.ts";
import {
  sanitizeSkillAttachments,
  type SkillAttachment,
} from "../shared/skill-attachments.ts";

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

/**
 * A sub-skill nested inside a parent skill. Same shape as `SubSkill` in
 * `src/skills/types.ts` (cross-tree imports are banned by the architecture
 * suite, so the shape is hand-copied).
 */
export interface SubSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  whenToUse?: string;
  alwaysInclude?: boolean;
  attachments?: SkillAttachment[];
}

/** A skill template loaded from central workspace `skills.json`. */
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
  attachments?: SkillAttachment[];
  subskills?: SubSkill[];
}

export { compileSkillTemplate, compileSkills } from "../shared/skill-prompt.ts";

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

function normalizeSkillTemplate(skill: SkillTemplate): SkillTemplate {
  const attachments = sanitizeSkillAttachments(skill.attachments);
  const subskills = Array.isArray(skill.subskills)
    ? skill.subskills
      .filter((sub): sub is SubSkill => typeof sub === "object" && sub !== null
        && typeof sub.id === "string" && typeof sub.name === "string"
        && typeof sub.description === "string" && typeof sub.body === "string")
      .map((sub) => {
        const subAttachments = sanitizeSkillAttachments(sub.attachments);
        const { attachments: _attachments, ...rest } = sub;
        return {
          ...rest,
          ...(subAttachments.length > 0 ? { attachments: subAttachments } : {}),
        };
      })
    : undefined;
  const { attachments: _attachments, subskills: _subskills, ...rest } = skill;
  return {
    ...rest,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(subskills ? { subskills } : {}),
  };
}

/**
 * Load every skill defined in the project's sidecar `skills.json`.
 * Returns an empty array when the file is missing or malformed.
 */
export function loadAllSkills(projectPath: string): SkillTemplate[] {
  const raw = readSkills(projectPath);
  const projectSkills = raw.filter(isSkillTemplate).map(normalizeSkillTemplate);
  const projectSkillIds = new Set(projectSkills.map((skill) => skill.id));
  const builtIns = builtInSkillPresets.filter(
    (skill) => !projectSkillIds.has(skill.id),
  );
  return [...builtIns, ...projectSkills];
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
