import type { SkillTemplate } from "./types.ts";

const registry = new Map<string, SkillTemplate>();
const builtInIds = new Set<string>();

export function registerSkill(
  def: SkillTemplate,
  options?: { builtIn?: boolean },
): void {
  registry.set(def.id, def);
  if (options?.builtIn) {
    builtInIds.add(def.id);
  }
}

export function unregisterSkill(id: string): void {
  registry.delete(id);
  builtInIds.delete(id);
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

export function isBuiltInSkill(id: string): boolean {
  return builtInIds.has(id);
}
