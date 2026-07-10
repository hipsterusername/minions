import type { SkillTemplate } from "./types.ts";
import { builtInSkillTemplates } from "./built-in-presets.ts";

const registry = new Map<string, SkillTemplate>();

export function registerSkill(def: SkillTemplate): void {
  registry.set(def.id, def);
}

export function unregisterSkill(id: string): void {
  registry.delete(id);
}

/**
 * Resolve a skill by id. Project skills (the registry) take precedence; a
 * built-in preset is returned as a fallback so tagged/armed built-ins render
 * and compile even though they never live in the registry.
 */
export function getSkill(id: string): SkillTemplate | undefined {
  return registry.get(id) ?? builtInSkillTemplates.find((s) => s.id === id);
}

/**
 * Project skills only — the persistence source of truth. `persistToServer`
 * and `exportUserSkills` build on this, so built-ins are never written to
 * `.minions/skills.json`.
 */
export function getAllSkills(): SkillTemplate[] {
  return Array.from(registry.values());
}

/**
 * The full set a user may pick/tag: project skills plus every built-in preset
 * they haven't overridden with a same-id project skill. Use this in pickers
 * and browsers; never in the persistence path.
 */
export function getPickableSkills(): SkillTemplate[] {
  const projectSkills = getAllSkills();
  const projectIds = new Set(projectSkills.map((s) => s.id));
  const builtIns = builtInSkillTemplates.filter((s) => !projectIds.has(s.id));
  return [...projectSkills, ...builtIns];
}

export function getSkillsByCategory(category: string): SkillTemplate[] {
  return Array.from(registry.values()).filter(
    (def) => def.category === category,
  );
}

/** Replace all skills in the registry (used when loading a project). */
export function setAllSkills(skills: SkillTemplate[]): void {
  registry.clear();
  for (const skill of skills) {
    registry.set(skill.id, skill);
  }
}

/** Clear all skills from the registry. */
export function clearSkills(): void {
  registry.clear();
}
