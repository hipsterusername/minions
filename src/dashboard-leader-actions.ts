import type { ComponentType } from "react";
import {
  Sparkles,
  Play,
  Microscope,
  Wrench,
  Search,
  Bug,
  Wand2,
  Rocket,
  Pencil,
  MessageSquareText,
  ListChecks,
  GitBranch,
  Slash,
  type LucideProps,
} from "lucide-react";
import type {
  DashboardLeaderActionConfig,
  ProjectSettings,
} from "./api.ts";

export type { DashboardLeaderActionConfig };

/**
 * The palette of icons a Context Action can use. Keyed by a stable string so
 * the choice survives serialization to `settings.json` and relabelling.
 */
export const DASHBOARD_ACTION_ICONS: ReadonlyArray<{
  key: string;
  label: string;
  Icon: ComponentType<LucideProps>;
}> = [
  { key: "play", label: "Implement", Icon: Play },
  { key: "sparkles", label: "Fix", Icon: Sparkles },
  { key: "microscope", label: "Review", Icon: Microscope },
  { key: "wrench", label: "Repair", Icon: Wrench },
  { key: "search", label: "Investigate", Icon: Search },
  { key: "bug", label: "Debug", Icon: Bug },
  { key: "wand", label: "Polish", Icon: Wand2 },
  { key: "rocket", label: "Ship", Icon: Rocket },
  { key: "pencil", label: "Write", Icon: Pencil },
  { key: "message", label: "Discuss", Icon: MessageSquareText },
  { key: "checklist", label: "Plan", Icon: ListChecks },
  { key: "branch", label: "Refactor", Icon: GitBranch },
];

export const DEFAULT_DASHBOARD_ACTION_ICON = "play";

const ICON_BY_KEY: ReadonlyMap<string, ComponentType<LucideProps>> = new Map(
  DASHBOARD_ACTION_ICONS.map(({ key, Icon }) => [key, Icon]),
);

/** Resolve an icon key to a component, falling back to a generic slash glyph. */
export function dashboardActionIcon(
  key: string | undefined,
): ComponentType<LucideProps> {
  return (key && ICON_BY_KEY.get(key)) || Slash;
}

/**
 * The built-in Context Actions shipped with every project. Users can rename,
 * re-prompt, reorder, extend, or delete these; the array here is only the
 * starting point and the target of "Reset to defaults".
 */
export const DEFAULT_DASHBOARD_LEADER_ACTIONS: ReadonlyArray<DashboardLeaderActionConfig> =
  [
    {
      id: "execute",
      name: "Implement",
      icon: "play",
      prompt:
        "Implement the change described by the connected context. Inspect the relevant code, make a complete production-ready change, run focused tests, and summarize what changed.",
    },
    {
      id: "improve",
      name: "Fix",
      icon: "sparkles",
      prompt:
        "Investigate the problem in the connected context. Trace the root cause, implement the smallest robust fix, add or update regression coverage, and verify the result.",
    },
    {
      id: "analyze",
      name: "Review",
      icon: "microscope",
      prompt:
        "Review the connected context and relevant code. Identify concrete bugs, risks, and missing cases, then report prioritized findings with file references. Do not make changes unless asked.",
    },
  ];

/** Deep clone of the built-in defaults, safe to hand to a mutable setter. */
export function defaultDashboardLeaderActions(): DashboardLeaderActionConfig[] {
  return DEFAULT_DASHBOARD_LEADER_ACTIONS.map((action) => ({ ...action }));
}

// ── Legacy shape (pre-array) ────────────────────────────────
// Older settings.json files stored two parallel records keyed by the built-in
// action ids. We migrate those to the array shape on read so no compat branch
// leaks into the UI. The keys are still readable through ProjectSettings'
// index signature.

interface LegacyActionRecords {
  names?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

function readLegacyRecords(settings: ProjectSettings): LegacyActionRecords {
  const names = settings["dashboardLeaderActionNames"];
  const prompts = settings["dashboardLeaderActionPrompts"];
  return {
    ...(isRecord(names) ? { names } : {}),
    ...(isRecord(prompts) ? { prompts } : {}),
  };
}

function legacyActionsToArray(
  legacy: LegacyActionRecords,
): DashboardLeaderActionConfig[] {
  return DEFAULT_DASHBOARD_LEADER_ACTIONS.map((base) => {
    const name = legacy.names?.[base.id];
    const prompt = legacy.prompts?.[base.id];
    return {
      ...base,
      name: nonBlankString(name) ?? base.name,
      prompt: nonBlankString(prompt) ?? base.prompt,
    };
  });
}

/**
 * Normalize any stored settings into the canonical ordered action array.
 *
 * Precedence:
 *   1. A valid `dashboardLeaderActions` array (sanitized entry-by-entry).
 *   2. Legacy `dashboardLeaderActionNames` / `dashboardLeaderActionPrompts`
 *      records, merged over the built-in defaults.
 *   3. The built-in defaults.
 */
export function normalizeDashboardLeaderActions(
  settings: ProjectSettings | undefined,
): DashboardLeaderActionConfig[] {
  const stored = settings?.dashboardLeaderActions;
  if (Array.isArray(stored)) {
    const sanitized = stored
      .map(sanitizeAction)
      .filter((action): action is DashboardLeaderActionConfig => action !== null);
    if (sanitized.length > 0) return dedupeIds(sanitized);
  }

  if (settings) {
    const legacy = readLegacyRecords(settings);
    if (legacy.names || legacy.prompts) return legacyActionsToArray(legacy);
  }

  return defaultDashboardLeaderActions();
}

function sanitizeAction(value: unknown): DashboardLeaderActionConfig | null {
  if (!isRecord(value)) return null;
  const id = nonBlankString(value["id"]);
  const name = nonBlankString(value["name"]);
  const prompt = nonBlankString(value["prompt"]);
  if (!id || !name || !prompt) return null;
  const icon = nonBlankString(value["icon"]) ?? DEFAULT_DASHBOARD_ACTION_ICON;
  return { id, name, prompt, icon };
}

/** Ensure ids are unique so React keys and lookups stay stable. */
function dedupeIds(
  actions: DashboardLeaderActionConfig[],
): DashboardLeaderActionConfig[] {
  const seen = new Set<string>();
  return actions.map((action) => {
    let id = action.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${action.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return id === action.id ? action : { ...action, id };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}
