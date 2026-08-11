/**
 * Pure logic for authoring skills into central workspace `skills.json`.
 *
 * The `skill-builder` built-in skill teaches an agent HOW to design skills;
 * this module is the WHAT — the validation, id-generation, variable
 * extraction, and array upsert/delete helpers that back the `create_skill`,
 * `update_skill`, `delete_skill`, `get_skill`, and `list_skills` tools
 * (see `server/skill-authoring-tools.ts`).
 *
 * Everything here is pure and FS-free so it can be unit-tested without a
 * temp project. The tool layer wires these to `readSkills`/`writeSkills`.
 * No bus events, no cross-tree imports (mirror types from `./skills.ts`).
 */

import { builtInSkillPresets } from "../shared/skill-presets.ts";
import type { SkillTemplate, SkillVariable, SubSkill } from "./skills.ts";
import {
  sanitizeSkillAttachments,
  type SkillAttachment,
} from "../shared/skill-attachments.ts";

/** Categories a skill may declare — mirror of the `SkillTemplate` union. */
export const SKILL_CATEGORIES = [
  "code",
  "docs",
  "testing",
  "devops",
  "analysis",
  "design",
  "general",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** Default accent + icon so a minimal draft still renders in the browser. */
const DEFAULT_ACCENT = "#6366f1";
const DEFAULT_ICON = "SK";

/**
 * Slugify a human name into a stable, url-safe skill id. Collapses runs of
 * non-alphanumerics to single hyphens and trims leading/trailing ones.
 * Empty input yields "skill" so an id is always produced.
 */
export function slugifySkillId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}

/** Extract unique `{{variable}}` names from a template, in first-seen order. */
export function extractTemplateVariableNames(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const name = match[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Runtime guard for entries pulled from `skills.json`. */
export function isRawSkill(value: unknown): value is SkillTemplate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["template"] === "string"
  );
}

/** Input shape accepted by `create_skill` / `update_skill` tool handlers. */
export interface SkillDraftInput {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  accentColor?: string;
  template?: string;
  variables?: SkillVariable[];
  attachments?: SkillAttachment[];
  subskills?: Array<Omit<SubSkill, "id"> & { id?: string }>;
}

export type BuildSkillResult =
  | { ok: true; skill: SkillTemplate }
  | { ok: false; error: string };

/** Normalize a category string, falling back to "general" when unknown. */
function normalizeCategory(category?: string): SkillCategory {
  return (SKILL_CATEGORIES as readonly string[]).includes(category ?? "")
    ? (category as SkillCategory)
    : "general";
}

/**
 * Turn an author's sub-skill drafts into fully-formed {@link SubSkill}s,
 * generating a stable id from each name when one is not supplied and
 * de-duplicating ids so the map stays addressable.
 */
function normalizeSubskills(
  drafts: SkillDraftInput["subskills"],
): SubSkill[] | undefined {
  if (!drafts || drafts.length === 0) return undefined;
  const used = new Set<string>();
  return drafts.map((draft) => {
    let id = (draft.id?.trim() || slugifySkillId(draft.name)).slice(0, 64);
    let n = 2;
    const base = id;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    const attachments = sanitizeSkillAttachments(draft.attachments);
    return {
      id,
      name: draft.name,
      description: draft.description,
      body: draft.body,
      ...(draft.whenToUse ? { whenToUse: draft.whenToUse } : {}),
      ...(draft.alwaysInclude ? { alwaysInclude: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    } satisfies SubSkill;
  });
}

/**
 * Build a validated {@link SkillTemplate} from author input. Auto-derives an
 * id from the name and auto-declares any template `{{placeholders}}` that the
 * author did not describe as plain text variables. Returns a typed error
 * (never throws) when required fields are missing.
 *
 * When `base` is supplied (update path), unspecified fields inherit from it so
 * a partial patch does not wipe the existing skill.
 */
export function buildSkillDraft(
  input: SkillDraftInput,
  base?: SkillTemplate,
): BuildSkillResult {
  const name = input.name?.trim() || base?.name;
  if (!name) return { ok: false, error: "A skill needs a non-empty name." };

  const template = input.template ?? base?.template;
  if (template === undefined || template.trim().length === 0) {
    return { ok: false, error: "A skill needs a non-empty template body." };
  }

  const id = input.id?.trim() || base?.id || slugifySkillId(name);

  // Merge author-declared variables with any placeholders they left implicit.
  const declared = input.variables ?? base?.variables ?? [];
  const declaredNames = new Set(declared.map((v) => v.name));
  const implicit: SkillVariable[] = extractTemplateVariableNames(template)
    .filter((n) => !declaredNames.has(n))
    .map((n) => ({ name: n, label: n, type: "text" }));

  const subskills =
    normalizeSubskills(input.subskills) ?? base?.subskills;
  const attachments = input.attachments !== undefined
    ? sanitizeSkillAttachments(input.attachments)
    : base?.attachments;

  return {
    ok: true,
    skill: {
      id,
      name,
      description: input.description ?? base?.description ?? "",
      category: normalizeCategory(input.category ?? base?.category),
      icon: input.icon ?? base?.icon ?? DEFAULT_ICON,
      accentColor: input.accentColor ?? base?.accentColor ?? DEFAULT_ACCENT,
      template,
      variables: [...declared, ...implicit],
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(subskills ? { subskills } : {}),
    },
  };
}

/**
 * Upsert a skill into a raw `skills.json` array. Replaces any existing entry
 * with the same id (preserving position); appends when new. Non-skill entries
 * are preserved untouched. Returns whether the write created a new entry.
 */
export function upsertSkillInArray(
  existing: unknown[],
  skill: SkillTemplate,
): { next: unknown[]; created: boolean } {
  let created = true;
  const next = existing.map((entry) => {
    if (isRawSkill(entry) && entry.id === skill.id) {
      created = false;
      return skill;
    }
    return entry;
  });
  if (created) next.push(skill);
  return { next, created };
}

/**
 * Remove a project skill by id. Returns the filtered array and whether an
 * entry was actually removed (false when the id was not a project skill).
 */
export function removeSkillFromArray(
  existing: unknown[],
  id: string,
): { next: unknown[]; removed: boolean } {
  const next = existing.filter(
    (entry) => !(isRawSkill(entry) && entry.id === id),
  );
  return { next, removed: next.length !== existing.length };
}

/** Compact summary of a skill for the `list_skills` tool. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  source: "built-in" | "project";
  variables: number;
  attachments: number;
  subskills: number;
}

/**
 * Summarize the full skill library an agent can author against: every project
 * skill (from `skills.json`) plus every built-in preset not overridden by a
 * project skill of the same id. Project skills that override a built-in are
 * still tagged "project" (they win at compile time).
 */
export function summarizeSkillLibrary(projectSkills: unknown[]): SkillSummary[] {
  const valid = projectSkills.filter(isRawSkill);
  const projectIds = new Set(valid.map((s) => s.id));
  const summarize = (
    s: SkillTemplate,
    source: SkillSummary["source"],
  ): SkillSummary => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    source,
    variables: s.variables?.length ?? 0,
    attachments: s.attachments?.length ?? 0,
    subskills: s.subskills?.length ?? 0,
  });
  const builtIns = builtInSkillPresets
    .filter((preset) => !projectIds.has(preset.id))
    .map((preset) => summarize(preset as SkillTemplate, "built-in"));
  const project = valid.map((s) => summarize(s, "project"));
  return [...builtIns, ...project];
}
