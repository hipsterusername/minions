export interface ContextActionConfig {
  id: string;
  name: string;
  prompt: string;
  icon: string;
  skillIds: string[];
}

export interface ContextActionValidationIssue {
  index: number;
  field: "id" | "name" | "prompt" | "icon" | "skillIds";
  message: string;
}

export const DEFAULT_CONTEXT_ACTION_ICON = "play";

export const DEFAULT_CONTEXT_ACTIONS: ReadonlyArray<ContextActionConfig> = [
  {
    id: "execute",
    name: "Implement",
    icon: "play",
    prompt:
      "Implement the change described by the connected context. Inspect the relevant code, make a complete production-ready change, run focused tests, and summarize what changed.",
    skillIds: [],
  },
  {
    id: "improve",
    name: "Fix",
    icon: "sparkles",
    prompt:
      "Investigate the problem in the connected context. Trace the root cause, implement the smallest robust fix, add or update regression coverage, and verify the result.",
    skillIds: [],
  },
  {
    id: "analyze",
    name: "Review",
    icon: "microscope",
    prompt:
      "Review the connected context and relevant code. Identify concrete bugs, risks, and missing cases, then report prioritized findings with file references. Do not make changes unless asked.",
    skillIds: [],
  },
];

export function defaultContextActions(): ContextActionConfig[] {
  return DEFAULT_CONTEXT_ACTIONS.map((action) => ({
    ...action,
    skillIds: [...action.skillIds],
  }));
}

type ContextActionSettings = Record<string, unknown> & {
  dashboardLeaderActions?: unknown;
};

/**
 * Read Context Actions using explicit absence semantics:
 * - an absent action list uses the built-in defaults;
 * - an empty list stays empty;
 * - legacy rows without skillIds migrate to an empty skill list.
 */
export function normalizeContextActions(
  settings: ContextActionSettings | undefined,
): ContextActionConfig[] {
  if (settings && Object.prototype.hasOwnProperty.call(settings, "dashboardLeaderActions")) {
    const stored = settings.dashboardLeaderActions;
    if (Array.isArray(stored)) {
      return dedupeActionIds(
        stored
          .map(sanitizeContextAction)
          .filter((action): action is ContextActionConfig => action !== null),
      );
    }
  }

  const legacy = settings ? legacyActions(settings) : null;
  return legacy ?? defaultContextActions();
}

export function validateContextActionList(value: unknown): {
  actions: ContextActionConfig[] | null;
  issues: ContextActionValidationIssue[];
} {
  if (!Array.isArray(value)) {
    return {
      actions: null,
      issues: [{ index: -1, field: "id", message: "dashboardLeaderActions must be an array" }],
    };
  }

  const issues: ContextActionValidationIssue[] = [];
  const actions: ContextActionConfig[] = [];
  const seenIds = new Set<string>();
  value.forEach((row, index) => {
    if (!isRecord(row)) {
      issues.push({ index, field: "id", message: "Action must be an object" });
      return;
    }
    const id = requiredString(row["id"], index, "id", issues);
    const name = requiredString(row["name"], index, "name", issues);
    const prompt = requiredString(row["prompt"], index, "prompt", issues);
    const icon = requiredString(row["icon"], index, "icon", issues);
    const skillIds = normalizeSkillIds(row["skillIds"], index, issues);
    if (id && seenIds.has(id)) {
      issues.push({ index, field: "id", message: `Duplicate action id: ${id}` });
    }
    if (id) seenIds.add(id);
    if (id && name && prompt && icon && skillIds) {
      actions.push({ id, name, prompt, icon, skillIds });
    }
  });
  return { actions: issues.length === 0 ? actions : null, issues };
}

export function invokeContextAction(
  action: Pick<ContextActionConfig, "prompt" | "skillIds">,
  currentSkillIds: readonly string[],
  availableSkillIds: Iterable<string>,
): { prompt: string; skillIds: string[]; missingSkillIds: string[] } {
  const available = new Set(availableSkillIds);
  const resolved = action.skillIds.filter((id) => available.has(id));
  const missingSkillIds = action.skillIds.filter((id) => !available.has(id));
  return {
    prompt: action.prompt,
    skillIds: stableUnique([...currentSkillIds, ...resolved]),
    missingSkillIds: stableUnique(missingSkillIds),
  };
}

export function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sanitizeContextAction(value: unknown): ContextActionConfig | null {
  if (!isRecord(value)) return null;
  const id = nonBlankString(value["id"]);
  const name = nonBlankString(value["name"]);
  const prompt = nonBlankString(value["prompt"]);
  if (!id || !name || !prompt) return null;
  const icon = nonBlankString(value["icon"]) ?? DEFAULT_CONTEXT_ACTION_ICON;
  const skillIds = Array.isArray(value["skillIds"])
    ? stableUnique(value["skillIds"].filter((id): id is string => typeof id === "string"))
    : [];
  return { id, name, prompt, icon, skillIds };
}

function dedupeActionIds(actions: ContextActionConfig[]): ContextActionConfig[] {
  const seen = new Set<string>();
  return actions.map((action) => {
    let id = action.id;
    let suffix = 2;
    while (seen.has(id)) id = `${action.id}-${suffix++}`;
    seen.add(id);
    return id === action.id ? action : { ...action, id };
  });
}

function legacyActions(settings: ContextActionSettings): ContextActionConfig[] | null {
  const names = isRecord(settings["dashboardLeaderActionNames"])
    ? settings["dashboardLeaderActionNames"]
    : null;
  const prompts = isRecord(settings["dashboardLeaderActionPrompts"])
    ? settings["dashboardLeaderActionPrompts"]
    : null;
  if (!names && !prompts) return null;
  return defaultContextActions().map((action) => ({
    ...action,
    name: nonBlankString(names?.[action.id]) ?? action.name,
    prompt: nonBlankString(prompts?.[action.id]) ?? action.prompt,
  }));
}

function normalizeSkillIds(
  value: unknown,
  index: number,
  issues: ContextActionValidationIssue[],
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ index, field: "skillIds", message: "skillIds must be an array of strings" });
    return null;
  }
  if (value.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    issues.push({ index, field: "skillIds", message: "skillIds must contain nonblank strings" });
    return null;
  }
  return stableUnique(value as string[]);
}

function requiredString(
  value: unknown,
  index: number,
  field: ContextActionValidationIssue["field"],
  issues: ContextActionValidationIssue[],
): string | null {
  const normalized = nonBlankString(value);
  if (!normalized) {
    issues.push({ index, field, message: `${field} is required` });
    return null;
  }
  return normalized;
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
