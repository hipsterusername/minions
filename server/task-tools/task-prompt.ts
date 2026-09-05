import { renderSourceExcerpt } from "../../shared/handoff-text.ts";
import { PROJECT_CONTEXT_CHAR_LIMIT } from "../../shared/project-context.ts";
export { PROJECT_CONTEXT_CHAR_LIMIT } from "../../shared/project-context.ts";
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
  projectContext?: string | null;
  projectContextSourceRef?: string;
  canvasContextSourceRef?: string;
}

export const CANVAS_CONTEXT_CHAR_LIMIT = 6000;
export const CANVAS_CONTEXT_TRUNCATED_MARKER = "…canvas context truncated";
export const PROJECT_CONTEXT_TRUNCATED_MARKER = "…project context truncated";

function appendListSection(lines: string[], title: string, items?: string[]): void {
  if (!items || items.length === 0) return;
  lines.push("", title, "", ...items.map((item) => `- ${item}`));
}

export function truncateCanvasContext(
  canvasContext: string,
  maxChars = CANVAS_CONTEXT_CHAR_LIMIT,
  sourceRef?: string,
): string {
  if (canvasContext.length <= maxChars) return canvasContext;
  const open = "<connected-context>\n";
  const close = "\n</connected-context>";
  const content = canvasContext.replace(/^<connected-context>\s*/, "").replace(/\s*<\/connected-context>$/, "");
  if (maxChars <= open.length + close.length) return renderSourceExcerpt(content, maxChars, sourceRef, CANVAS_CONTEXT_TRUNCATED_MARKER);
  const budget = maxChars - open.length - close.length;
  const groups = [...content.matchAll(/<context-group\b[^>]*>[\s\S]*?<\/context-group>/g)];
  const footer = `\n${CANVAS_CONTEXT_TRUNCATED_MARKER}\n${sourceRef
    ? `Full source (reference data): ${sourceRef}`
    : "Full source unavailable to this renderer; request missing context from the Leader."}`;
  let excerpt = groups.length ? content.slice(0, groups[0]!.index) : "";
  let kept = 0;
  for (const group of groups) {
    if (excerpt.length + group[0].length + 1 + footer.length > budget) break;
    excerpt += group[0] + "\n";
    kept++;
  }
  // A single oversized source must still provide actionable content and provenance.
  return open + (kept ? excerpt + footer
    : renderSourceExcerpt(content, budget, sourceRef, CANVAS_CONTEXT_TRUNCATED_MARKER)) + close;
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

  if (args.projectContext) {
    const projectContext = renderSourceExcerpt(args.projectContext, PROJECT_CONTEXT_CHAR_LIMIT,
      args.projectContextSourceRef, PROJECT_CONTEXT_TRUNCATED_MARKER);
    lines.push("", "## Minions project context", "", projectContext);
  }

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
      truncateCanvasContext(args.canvasContext, CANVAS_CONTEXT_CHAR_LIMIT, args.canvasContextSourceRef),
    );
  }

  return lines.join("\n");
}
