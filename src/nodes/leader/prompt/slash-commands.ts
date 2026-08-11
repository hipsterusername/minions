import type { ProjectSettings } from "../../../api.ts";
import { normalizeDashboardLeaderActions } from "../../../dashboard-leader-actions.ts";

const DESCRIPTION_MAX_LENGTH = 60;

export type SlashCommand = {
  id: string;
  label: string;
  description: string;
  insertText: string;
  /** Icon key from the action config; the menu falls back if unknown. */
  icon?: string;
  /** Skill recipe retained even when some ids are currently unavailable. */
  skillIds?: string[];
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
  return normalizeDashboardLeaderActions(settings).map((action) => ({
    id: action.id,
    label: action.name,
    description:
      action.prompt.length > DESCRIPTION_MAX_LENGTH
        ? `${action.prompt.slice(0, DESCRIPTION_MAX_LENGTH)}…`
        : action.prompt,
    insertText: action.prompt,
    icon: action.icon,
    skillIds: [...action.skillIds],
  }));
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
