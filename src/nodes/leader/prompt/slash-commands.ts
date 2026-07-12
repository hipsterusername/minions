import type { ProjectSettings } from "../../../api.ts";
import {
  DASHBOARD_LEADER_ACTIONS,
  resolveDashboardLeaderActionName,
  resolveDashboardLeaderPrompt,
  type DashboardLeaderAction,
} from "../../../dashboard-leader-actions.ts";

const DESCRIPTION_MAX_LENGTH = 60;

export type SlashCommand = {
  id: DashboardLeaderAction;
  label: string;
  description: string;
  insertText: string;
};

export function parseSlashQuery(input: string): string | null {
  if (!input.startsWith("/") || input.includes("\n") || input.includes("\r")) {
    return null;
  }

  return input.slice(1);
}

export function buildSlashCommands(
  settings: ProjectSettings | undefined,
): SlashCommand[] {
  return DASHBOARD_LEADER_ACTIONS.map(({ action }) => {
    const prompt = resolveDashboardLeaderPrompt(settings, action);
    return {
      id: action,
      label: resolveDashboardLeaderActionName(settings, action),
      description:
        prompt.length > DESCRIPTION_MAX_LENGTH
          ? `${prompt.slice(0, DESCRIPTION_MAX_LENGTH)}…`
          : prompt,
      insertText: prompt,
    };
  });
}

export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return commands;

  return commands.filter((command) =>
    command.label.toLowerCase().includes(normalizedQuery),
  );
}
