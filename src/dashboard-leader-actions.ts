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
import type { ProjectSettings } from "./api.ts";
import {
  DEFAULT_CONTEXT_ACTION_ICON,
  defaultContextActions,
  normalizeContextActions,
  type ContextActionConfig,
} from "../shared/context-actions.ts";

export type DashboardLeaderActionConfig = ContextActionConfig;

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

export const DEFAULT_DASHBOARD_ACTION_ICON = DEFAULT_CONTEXT_ACTION_ICON;

const ICON_BY_KEY: ReadonlyMap<string, ComponentType<LucideProps>> = new Map(
  DASHBOARD_ACTION_ICONS.map(({ key, Icon }) => [key, Icon]),
);

export function dashboardActionIcon(
  key: string | undefined,
): ComponentType<LucideProps> {
  return (key && ICON_BY_KEY.get(key)) || Slash;
}

export const DEFAULT_DASHBOARD_LEADER_ACTIONS = defaultContextActions();

export function defaultDashboardLeaderActions(): DashboardLeaderActionConfig[] {
  return defaultContextActions();
}

export function normalizeDashboardLeaderActions(
  settings: ProjectSettings | undefined,
): DashboardLeaderActionConfig[] {
  return normalizeContextActions(settings);
}
