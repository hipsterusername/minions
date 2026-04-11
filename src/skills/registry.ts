import type { SkillTemplate } from "./types.ts";

const registry = new Map<string, SkillTemplate>();

export function registerSkill(def: SkillTemplate): void {
  registry.set(def.id, def);
}

export function unregisterSkill(id: string): void {
  registry.delete(id);
}

export function getSkill(id: string): SkillTemplate | undefined {
  return registry.get(id);
}

export function getAllSkills(): SkillTemplate[] {
  return Array.from(registry.values());
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
