import type { ProjectSettings } from "../../../api.ts";
import { normalizeDashboardLeaderActions } from "../../../dashboard-leader-actions.ts";

const DESCRIPTION_MAX_LENGTH = 60;

const SHIP_PROMPT = `Review the intended changes for personal information and secrets, then commit and push them.

1. Inspect repository instructions, git status, staged and unstaged changes, and relevant untracked files. Identify the intended scope from this conversation; preserve unrelated work and existing staging. Confirm the current branch and push destination. If scope or destination is ambiguous, finish the review and ask only for the missing decision.
2. Review the files to be committed and every outgoing commit, including intermediate changes, deleted content, commit messages, and author/committer metadata. Look for credentials, tokens, private keys, personal contact details, usernames, absolute local paths, private URLs, session identifiers, logs, screenshots, and local working artifacts. Distinguish intentional public attribution and fictional fixtures from accidental disclosure. Inspect binary assets when relevant; report anything you cannot inspect. Use an available secret scanner as an additional check, without claiming it proves the absence of personal data.
3. Sanitize accidental disclosures in the intended changes using portable placeholders or configuration, preserving behavior. Keep local artifacts out of the commit. Report findings by path and category without repeating sensitive values. If sensitive data exists in outgoing history, stop before pushing and explain the required cleanup; a later deletion does not remove it from history. Do not rewrite existing commits without authorization.
4. Run repository-required checks and relevant tests. Stage only reviewed files or hunks explicitly, inspect the complete staged diff, and recheck after any fixes or hook changes. Stop on unresolved findings, unreviewed content, or failed required checks. Never bypass hooks or force-add ignored artifacts.
5. Commit the reviewed changes with a concise message, then verify the resulting commit and the full outgoing range before pushing to the confirmed destination. If there are no new changes, skip the empty commit and review any existing outgoing commits before pushing. This request authorizes the normal commit and push once checks pass; do not ask for redundant confirmation. Never force-push, discard unrelated work, or change remotes. If the push is rejected, report the blocker without resetting or rewriting history.

Report the privacy review result and its limitations, checks run, commit hash, and push destination and outcome. State clearly if anything remains uncommitted or unpushed.`;

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
  let shipId = "ship";
  while (commands.some((command) => command.id === shipId)) shipId += "-feature";
  commands.push({
    id: shipId,
    label: "Ship",
    description: "Review personal info and secrets, then commit and push",
    insertText: SHIP_PROMPT,
    icon: "rocket",
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
