import { compileWorktreeCompletionPolicy } from "../session-host-config.ts";

interface TaskSpawnPromptArgs {
  taskId: string;
  title: string;
  priority: string;
  description: string;
  worktreeBranch?: string | null;
  armedSkillIds: string[];
  files?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  ownedPaths?: string[];
  canvasContext?: string | null;
  contextPack?: string | null;
}

export const CANVAS_CONTEXT_CHAR_LIMIT = 6000;
export const CANVAS_CONTEXT_TRUNCATED_MARKER = "…canvas context truncated";

function appendListSection(lines: string[], title: string, items?: string[]): void {
  if (!items || items.length === 0) return;
  lines.push("", title, "", ...items.map((item) => `- ${item}`));
}

function renderTruncatedContext(
  prefix: string,
  groups: string[],
  suffix: string,
  maxChars: number,
): string {
  const render = (kept: string[]) =>
    `${prefix}${kept.length > 0 ? `${kept.join("\n")}\n` : ""}${CANVAS_CONTEXT_TRUNCATED_MARKER}${suffix}`;
  const kept: string[] = [];
  for (let i = 0; i < groups.length - 1; i++) {
    const candidate = render([...kept, groups[i]!]);
    if (candidate.length > maxChars) break;
    kept.push(groups[i]!);
  }
  return render(kept);
}

export function truncateCanvasContext(
  canvasContext: string,
  maxChars = CANVAS_CONTEXT_CHAR_LIMIT,
): string {
  if (canvasContext.length <= maxChars) return canvasContext;
  const groupRegex = /<context-group(?:\s+title="[^"]*")?>[\s\S]*?<\/context-group>/g;
  const matches = Array.from(canvasContext.matchAll(groupRegex));
  if (matches.length === 0) return CANVAS_CONTEXT_TRUNCATED_MARKER;

  const firstIndex = matches[0]!.index ?? 0;
  const last = matches[matches.length - 1]!;
  const lastEnd = (last.index ?? 0) + last[0].length;
  const groups = matches.map((match) => match[0]);
  return renderTruncatedContext(
    canvasContext.slice(0, firstIndex),
    groups,
    canvasContext.slice(lastEnd),
    maxChars,
  );
}

export function buildTaskSpawnPrompt(args: TaskSpawnPromptArgs): string {
  const lines: string[] = [
    "## Task Assignment",
    "",
    `**Task ID:** ${args.taskId}`,
    `**Title:** ${args.title}`,
    `**Priority:** ${args.priority}`,
  ];

  if (args.worktreeBranch) {
    const sharedWorktreePolicy = compileWorktreeCompletionPolicy({
      role: "minion",
      canonical: false,
      sharedWorktree: true,
    })
      .map((line) => line.replace(/^- /, ""))
      .join(" ");
    lines.push(
      `**Worktree branch:** \`${args.worktreeBranch}\` - your cwd is inside the Leader's shared worktree. ${sharedWorktreePolicy}`,
    );
  }
  if (args.armedSkillIds.length > 0) {
    lines.push(
      `**Armed skills:** ${args.armedSkillIds.join(", ")} - detailed instructions are in your system prompt under "Active Skills".`,
    );
  }
  lines.push(
    "**Project context:** Skim `CLAUDE.md` at the repo root before significant work - it captures conventions and testing rules the Leader expects.",
  );

  if (args.contextPack) {
    lines.push("", "## System Model Context", "", args.contextPack);
  }
  lines.push("", "## Description", "", args.description);
  appendListSection(lines, "## Files / surface area", args.files);
  appendListSection(lines, "## Constraints", args.constraints);
  appendListSection(lines, "## Acceptance criteria", args.acceptanceCriteria);
  appendListSection(lines, "## Owned paths (your write boundary)", args.ownedPaths);
  if (args.canvasContext) {
    lines.push(
      "",
      "## Canvas context (from connected nodes)",
      "",
      truncateCanvasContext(args.canvasContext),
    );
  }

  return lines.join("\n");
}
