import type { ProjectSettings } from "./api.ts";

export type DashboardLeaderAction = "improve" | "execute" | "analyze";

export const DASHBOARD_LEADER_ACTIONS: Array<{
  action: DashboardLeaderAction;
  label: string;
}> = [
  { action: "execute", label: "Implement" },
  { action: "improve", label: "Fix" },
  { action: "analyze", label: "Review" },
];

export const DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS: Record<
  DashboardLeaderAction,
  string
> = {
  improve:
    "Investigate the problem in the connected context. Trace the root cause, implement the smallest robust fix, add or update regression coverage, and verify the result.",
  execute:
    "Implement the change described by the connected context. Inspect the relevant code, make a complete production-ready change, run focused tests, and summarize what changed.",
  analyze:
    "Review the connected context and relevant code. Identify concrete bugs, risks, and missing cases, then report prioritized findings with file references. Do not make changes unless asked.",
};

export const DEFAULT_DASHBOARD_LEADER_ACTION_NAMES: Record<
  DashboardLeaderAction,
  string
> = Object.fromEntries(
  DASHBOARD_LEADER_ACTIONS.map(({ action, label }) => [action, label]),
) as Record<DashboardLeaderAction, string>;

export function resolveDashboardLeaderActionName(
  settings: ProjectSettings | undefined,
  action: DashboardLeaderAction,
): string {
  const configured = settings?.dashboardLeaderActionNames?.[action];
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_DASHBOARD_LEADER_ACTION_NAMES[action];
}

export function resolveDashboardLeaderPrompt(
  settings: ProjectSettings | undefined,
  action: DashboardLeaderAction,
): string {
  const configured = settings?.dashboardLeaderActionPrompts?.[action];
  return typeof configured === "string" && configured.trim().length > 0
    ? configured
    : DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS[action];
}
