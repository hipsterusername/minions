/**
 * Project Skills Management
 *
 * Skills are stored per-project on the server in .minions/skills.json.
 * This module manages syncing between the in-memory registry and the server.
 */

import type { SkillTemplate } from "./types.ts";
import {
  registerSkill,
  unregisterSkill,
  getAllSkills,
  getPickableSkills,
  setAllSkills,
} from "./registry.ts";
import { getProjectSkills, saveProjectSkills } from "../api.ts";
import { serializeSkills, parseSkillTransfer } from "./skill-transfer.ts";
import { browserLogger } from "../logging.ts";

const log = browserLogger.child("user-skills");

let currentProjectId: string | null = null;

/** Set the current project context for skills operations. */
export function setSkillsProjectId(projectId: string | null): void {
  currentProjectId = projectId;
}

/**
 * Load skills from the server for the given project and populate the registry.
 * Returns the *pickable* set (project skills + built-in presets) so callers
 * that render a picker (e.g. the mobile LaunchScreen) surface built-ins too.
 * The registry itself stays project-only, keeping the persistence path clean.
 */
export async function loadProjectSkills(projectId: string): Promise<SkillTemplate[]> {
  const skills = await getProjectSkills(projectId);
  setAllSkills(skills);
  currentProjectId = projectId;
  return getPickableSkills();
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

/**
 * Export skills as a JSON string in the versioned transfer format. Defaults
 * to every project skill; pass an explicit list to export a subset (e.g. a
 * single skill from a card).
 */
export function exportUserSkills(skills: SkillTemplate[] = getAllSkills()): string {
  return serializeSkills(skills, new Date().toISOString());
}

/**
 * Register a validated set of skills and persist. Merges by id (an incoming
 * skill with an existing id overwrites it). Returns the count registered.
 * Used by the import-preview flow once the user has chosen what to import.
 */
export async function importSkillList(skills: SkillTemplate[]): Promise<number> {
  if (skills.length === 0) return 0;
  for (const s of skills) {
    registerSkill(s);
  }
  await persistToServer();
  return skills.length;
}

/**
 * Parse + import skills from a JSON string. Accepts the wrapped transfer
 * format and the legacy bare array. Returns count of imported skills. Merges
 * by id. Throws on malformed input.
 */
export async function importUserSkills(json: string): Promise<number> {
  const { skills } = parseSkillTransfer(json);
  return importSkillList(skills);
}

/** Persist the current registry state to the server. */
async function persistToServer(): Promise<void> {
  if (!currentProjectId) {
    log.warn("persist_skipped_missing_project");
    return;
  }
  const allSkills = getAllSkills();
  await saveProjectSkills(currentProjectId, allSkills);
}
