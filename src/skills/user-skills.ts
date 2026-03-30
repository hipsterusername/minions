import type { SkillTemplate } from "./types.ts";
import { registerSkill, unregisterSkill } from "./registry.ts";

const STORAGE_KEY = "canvas-user-skills";

/** Load all user skills from localStorage */
export function loadUserSkills(): SkillTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SkillTemplate[];
  } catch {
    return [];
  }
}

function saveToStorage(skills: SkillTemplate[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(skills));
}

/** Save a user skill (create or update). Also registers it in the registry. */
export function saveUserSkill(skill: SkillTemplate): void {
  const skills = loadUserSkills();
  const idx = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    skills[idx] = skill;
  } else {
    skills.push(skill);
  }
  saveToStorage(skills);
  registerSkill(skill);
}

/** Delete a user skill by id. Also unregisters it from the registry. */
export function deleteUserSkill(id: string): void {
  const skills = loadUserSkills().filter((s) => s.id !== id);
  saveToStorage(skills);
  unregisterSkill(id);
}

/** Check if a skill id is a user-created skill */
export function isUserSkill(id: string): boolean {
  const skills = loadUserSkills();
  return skills.some((s) => s.id === id);
}

/** Export user skills as a JSON string for sharing */
export function exportUserSkills(): string {
  return JSON.stringify(loadUserSkills(), null, 2);
}

/** Import skills from a JSON string. Returns count of imported skills. Merges by id. */
export function importUserSkills(json: string): number {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid import data: expected an array");
  }

  const valid = parsed.filter(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      typeof (item as Record<string, unknown>).id === "string" &&
      "name" in item &&
      typeof (item as Record<string, unknown>).name === "string" &&
      "template" in item &&
      typeof (item as Record<string, unknown>).template === "string",
  ) as SkillTemplate[];

  if (valid.length === 0) return 0;

  const existing = loadUserSkills();
  const merged = new Map<string, SkillTemplate>();
  for (const s of existing) merged.set(s.id, s);
  for (const s of valid) merged.set(s.id, s);

  const allSkills = Array.from(merged.values());
  saveToStorage(allSkills);

  for (const s of allSkills) {
    registerSkill(s);
  }

  return valid.length;
}

/**
 * Load user skills from localStorage and register them all in the registry.
 * Call this on app startup after built-in skills are registered.
 */
export function initUserSkills(): void {
  const skills = loadUserSkills();
  for (const skill of skills) {
    registerSkill(skill);
  }
}
