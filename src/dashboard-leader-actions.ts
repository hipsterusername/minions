import type { ProjectSettings } from "./api.ts";

export type DashboardLeaderAction = "improve" | "execute" | "analyze";

export const DASHBOARD_LEADER_ACTIONS: Array<{
  action: DashboardLeaderAction;
  label: string;
}> = [
  { action: "improve", label: "Improve" },
  { action: "execute", label: "Execute" },
  { action: "analyze", label: "Analyze" },
];

export const DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS: Record<
  DashboardLeaderAction,
  string
> = {
  improve:
    "Improve the connected dashboard context. Identify the highest-impact changes, then implement or produce the improved result.",
  execute:
    "Execute the work implied by the connected dashboard context. Use the dashboard as source context and carry the task through to completion.",
  analyze:
    "Analyze the connected dashboard context. Summarize the key findings, risks, and recommended next steps.",
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
