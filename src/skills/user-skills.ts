/**
 * Project Skills Management
 *
 * Skills are stored per-project on the server in .claude-canvas/skills.json.
 * This module manages syncing between the in-memory registry and the server.
 */

import type { SkillTemplate } from "./types.ts";
import {
  registerSkill,
  unregisterSkill,
  getAllSkills,
  setAllSkills,
} from "./registry.ts";
import { getProjectSkills, saveProjectSkills } from "../api.ts";

let currentProjectId: string | null = null;

/** Set the current project context for skills operations. */
export function setSkillsProjectId(projectId: string | null): void {
  currentProjectId = projectId;
}

/** Load skills from the server for the given project and populate the registry. */
export async function loadProjectSkills(projectId: string): Promise<SkillTemplate[]> {
  const skills = await getProjectSkills(projectId);
  setAllSkills(skills);
  currentProjectId = projectId;
  return skills;
}

/** Load skills from already-fetched data (e.g. from project open response). */
export function loadProjectSkillsFromData(projectId: string, skills: SkillTemplate[]): void {
  setAllSkills(skills);
  currentProjectId = projectId;
}

/** Save a skill (create or update). Persists to the server. */
export async function saveUserSkill(skill: SkillTemplate): Promise<void> {
  registerSkill(skill);
  await persistToServer();
}

/** Delete a skill by id. Persists to the server. */
export async function deleteUserSkill(id: string): Promise<void> {
  unregisterSkill(id);
  await persistToServer();
}

/** Export all project skills as a JSON string for sharing. */
export function exportUserSkills(): string {
  return JSON.stringify(getAllSkills(), null, 2);
}

/** Import skills from a JSON string. Returns count of imported skills. Merges by id. */
export async function importUserSkills(json: string): Promise<number> {
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

  // Merge into existing skills
  for (const s of valid) {
    registerSkill(s);
  }

  await persistToServer();
  return valid.length;
}

/** Persist the current registry state to the server. */
async function persistToServer(): Promise<void> {
  if (!currentProjectId) {
    console.warn("Cannot persist skills: no project ID set");
    return;
  }
  const allSkills = getAllSkills();
  await saveProjectSkills(currentProjectId, allSkills);
}
