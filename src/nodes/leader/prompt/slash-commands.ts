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
  aliases?: string[];
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
  const commands: SlashCommand[] = normalizeDashboardLeaderActions(settings).map((action) => ({
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
  // Feature commands remain available independently of editable context actions.
  let graphId = "task-graph";
  while (commands.some((command) => command.id === graphId)) graphId += "-feature";
  commands.push({
    id: graphId,
    label: "Graph",
    aliases: ["crew"],
    description: "Coordinate work with a task graph · /graph or /crew",
    insertText: "Use the Task Graph feature to plan and coordinate this work. Inspect the current graph first, then create or update the plan with dependencies and delegate through the graph scheduler. Follow the current graph review and start settings.",
    icon: "crew",
  });
  return commands;
}

export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return commands;

  return commands.filter((command) =>
    [command.label, ...(command.aliases ?? [])].some((name) =>
      name.toLowerCase().includes(normalizedQuery)),
  );
}
