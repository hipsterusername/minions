/**
 * Skill Import/Export ("transfer") format.
 *
 * A small, versioned container so exported skill bundles are self-describing
 * and forward/backward compatible. Serialization always writes the current
 * wrapped format; parsing accepts both the wrapped format and the legacy
 * bare-array shape ({@link exportUserSkills} used to emit a raw `SkillTemplate[]`).
 */

import type { SkillTemplate, SkillVariable } from "./types.ts";

/** Marker identifying a Minions skills bundle. */
export const SKILL_TRANSFER_FORMAT = "minions-skills";
/** Current transfer schema version. Bump on breaking shape changes. */
export const SKILL_TRANSFER_VERSION = 1;

/** The wrapped, self-describing export container. */
export interface SkillTransferFile {
  format: typeof SKILL_TRANSFER_FORMAT;
  version: number;
  /** ISO timestamp of when the bundle was produced. */
  exportedAt: string;
  skills: SkillTemplate[];
}

/** Result of parsing a transfer payload. */
export interface SkillTransferParse {
  /** Skills that passed validation and are safe to import. */
  skills: SkillTemplate[];
  /** Count of entries that were present but invalid (and thus dropped). */
  skipped: number;
}

const CATEGORIES = new Set([
  "code",
  "docs",
  "testing",
  "devops",
  "analysis",
  "design",
  "general",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function sanitizeVariables(raw: unknown): SkillVariable[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillVariable[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isString(item["name"])) continue;
    const type = item["type"];
    out.push({
      name: item["name"],
      label: isString(item["label"]) ? item["label"] : item["name"],
      type: type === "textarea" || type === "select" ? type : "text",
      ...(isString(item["placeholder"]) ? { placeholder: item["placeholder"] } : {}),
      ...(typeof item["required"] === "boolean" ? { required: item["required"] } : {}),
      ...(isString(item["defaultValue"]) ? { defaultValue: item["defaultValue"] } : {}),
      ...(isString(item["description"]) ? { description: item["description"] } : {}),
      ...(Array.isArray(item["options"])
        ? {
            options: (item["options"] as unknown[])
              .filter((o): o is { value: string; label: string } =>
                isRecord(o) && isString(o["value"]) && isString(o["label"]),
              )
              .map((o) => ({ value: o.value, label: o.label })),
          }
        : {}),
    });
  }
  return out;
}

/**
 * Validate + normalize a single unknown value into a {@link SkillTemplate}.
 * Returns `null` when the required shape (id/name/template) is missing so
 * callers can count and skip malformed entries. Unknown fields are dropped;
 * the `builtIn` flag is always stripped so imports become normal, editable,
 * persisted project skills.
 */
export function coerceSkill(raw: unknown): SkillTemplate | null {
  if (!isRecord(raw)) return null;
  if (!isString(raw["id"]) || !raw["id"].trim()) return null;
  if (!isString(raw["name"]) || !raw["name"].trim()) return null;
  if (!isString(raw["template"])) return null;

  const category = isString(raw["category"]) && CATEGORIES.has(raw["category"])
    ? (raw["category"] as SkillTemplate["category"])
    : "general";

  const skill: SkillTemplate = {
    id: raw["id"],
    name: raw["name"],
    description: isString(raw["description"]) ? raw["description"] : "",
    category,
    icon: isString(raw["icon"]) && raw["icon"].trim() ? raw["icon"] : "⚡",
    accentColor: isString(raw["accentColor"]) ? raw["accentColor"] : "var(--info-color)",
    template: raw["template"],
    variables: sanitizeVariables(raw["variables"]),
  };

  if (Array.isArray(raw["subskills"])) {
    const subs = (raw["subskills"] as unknown[])
      .filter((s): s is Record<string, unknown> => isRecord(s) && isString(s["name"]))
      .map((s) => ({
        id: isString(s["id"]) ? s["id"] : String(s["name"]).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        name: String(s["name"]),
        description: isString(s["description"]) ? s["description"] : "",
        body: isString(s["body"]) ? s["body"] : "",
        ...(isString(s["whenToUse"]) ? { whenToUse: s["whenToUse"] } : {}),
        ...(typeof s["alwaysInclude"] === "boolean" ? { alwaysInclude: s["alwaysInclude"] } : {}),
      }));
    if (subs.length > 0) skill.subskills = subs;
  }

  return skill;
}

/**
 * Serialize skills into the wrapped transfer format as pretty JSON.
 * `now` is injected (rather than read from the clock) to keep this pure and
 * testable; callers pass `new Date().toISOString()`.
 */
export function serializeSkills(skills: SkillTemplate[], now: string): string {
  // Strip the read-only `builtIn` marker so exports are portable, editable copies.
  const cleaned = skills.map(({ builtIn: _builtIn, ...rest }) => rest);
  const file: SkillTransferFile = {
    format: SKILL_TRANSFER_FORMAT,
    version: SKILL_TRANSFER_VERSION,
    exportedAt: now,
    skills: cleaned,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a transfer payload. Accepts the wrapped {@link SkillTransferFile}
 * container as well as the legacy bare `SkillTemplate[]` array. Throws when
 * the JSON is malformed or the top-level shape is neither a bundle nor an
 * array. Individual malformed skills are skipped and counted, not fatal.
 */
export function parseSkillTransfer(json: string): SkillTransferParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("File is not valid JSON");
  }

  let rawSkills: unknown[];
  if (Array.isArray(parsed)) {
    rawSkills = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed["skills"])) {
    rawSkills = parsed["skills"] as unknown[];
  } else {
    throw new Error("Unrecognized skills file: expected a skills array or bundle");
  }

  const skills: SkillTemplate[] = [];
  let skipped = 0;
  for (const raw of rawSkills) {
    const skill = coerceSkill(raw);
    if (skill) skills.push(skill);
    else skipped += 1;
  }

  return { skills, skipped };
}
