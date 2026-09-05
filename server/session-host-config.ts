/**
 * Static configuration + type definitions used by `SessionHost`.
 *
 * Kept separate so the host class remains under the 400-line architecture
 * ceiling. Contains:
 *   - Shared type aliases (roles, statuses, buffered events)
 *   - Adaptive-thinking config + validation
 *   - `deriveTaskName` prompt helper
 *   - Buffer cap constant
 *
 * None of this module holds state — everything exported is a pure value
 * or a pure function.
 */

export const MAX_BUFFERED_EVENTS = 200;

import type { NormalizedEvent } from "./harness/types.ts";

export type SessionRole =
  | "leader"
  | "minion"
  | "default"
  | "dialectic-planner";

export type SessionStatus =
  | "running"
  | "idle"
  | "stopped"
  | "error"
  | "completed";

export interface BufferedEvent {
  type: string;
  sessionKey: string;
  /**
   * Canonical immutable run identity. Compatibility events may omit it and
   * remain readable; compatibility runs use `sessionKey` as the value.
   */
  runKey?: string;
  /** Durable work-item identity when the launch boundary supplied one. */
  workItemId?: string | null;
  /**
   * For type="sdk_event": the normalized event payload.
   * The client reads this field on inbound `sdk_event` envelopes.
   */
  event?: NormalizedEvent;
  /**
   * Legacy field retained so existing test fixtures that create
   * hand-crafted BufferedEvent objects (e.g. the buffer-cap test) do not
   * need to be updated. New sdk_event writes set `event`, not `message`.
   */
  message?: unknown;
  status?: string;
  error?: string;
  sessionId?: string;
  timestamp: number;
  /**
   * Allow harnesses/handlers to attach arbitrary fields without losing
   * BusPayload compatibility. BusPayload requires `{ type: string } &
   * Record<string, unknown>`; this index signature satisfies that constraint
   * so BufferedEvent can be passed directly to bus.emitToSession().
   */
  [key: string]: unknown;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingDisplay = "summarized" | "omitted";

export interface ThinkingConfig {
  enabled: boolean;
  effort: EffortLevel;
  display: ThinkingDisplay;
}

const VALID_EFFORTS: ReadonlySet<EffortLevel> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const VALID_DISPLAYS: ReadonlySet<ThinkingDisplay> = new Set([
  "summarized",
  "omitted",
]);

/** Models that accept `thinking: {type: "adaptive"}` */
const ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set([
  "sonnet",
  "fable",
  "opus",
  "opus-old",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-mythos-preview",
]);

export function isValidThinkingConfig(v: unknown): v is ThinkingConfig {
  if (typeof v !== "object" || v === null) return false;
  const cfg = v as Record<string, unknown>;
  return (
    typeof cfg.enabled === "boolean" &&
    typeof cfg.effort === "string" &&
    VALID_EFFORTS.has(cfg.effort as EffortLevel) &&
    typeof cfg.display === "string" &&
    VALID_DISPLAYS.has(cfg.display as ThinkingDisplay)
  );
}

export function modelSupportsAdaptive(model: string | null): boolean {
  if (!model) return false;
  return ADAPTIVE_THINKING_MODELS.has(model);
}

/** Derive a short task name from a user prompt. */
export function deriveTaskName(prompt: string): string {
  // Strip connected-context wrapper if present
  let clean = prompt.replace(/<connected-context>[\s\S]*?<\/connected-context>\s*/g, "").trim();
  // Take first line only
  clean = (clean.split("\n")[0] ?? "").trim();
  // Truncate to 40 chars
  if (clean.length > 40) {
    clean = clean.slice(0, 37) + "…";
  }
  return clean || "Leader Session";
}

export interface WorktreePromptMode {
  role: "leader" | "minion";
  canonical: boolean;
  sharedWorktree: boolean;
}

/** Compile completion and integration rules for the session's worktree mode. */
export function compileWorktreeCompletionPolicy(
  mode: WorktreePromptMode,
): string[] {
  if (mode.role === "minion") {
    return mode.sharedWorktree
      ? [
          "- Keep edits within your assigned files and avoid reverting changes you did not make.",
          "- Do not run `git commit`; the orchestrator owns committing and integration.",
          "- **Do NOT** create branches, merge, rebase, or push — the orchestrator manages all integration.",
          "- **Do NOT modify .git files or config** — the worktree shares a .git link with the main repo.",
        ]
      : [
          "- **Commit your work** (`git add -A && git commit -m \"...\"`) before calling `report_done`. The orchestrator has an auto-commit fallback, but explicit commits produce cleaner history.",
          "- **Do NOT** create branches, merge, rebase, or push — the orchestrator manages all integration.",
          "- **Do NOT modify .git files or config** — the worktree shares a .git link with the main repo.",
        ];
  }

  if (mode.canonical) {
    return [
      "- If you delegate through an available agent tool, give the child the assigned cwd and ownership boundary.",
      "- When delegating to minions via assign_task, they will automatically work in your worktree.",
      "",
      "### Canonical Completion",
      "",
      "- When ALL work is complete, finish with a final summary report.",
      "- Contribution collection, gates, and lineage integration are automatic; do not call `request_approval`.",
    ];
  }

  return [
    "- If you delegate through an available agent tool, give the child the assigned cwd and ownership boundary.",
    "- When delegating to minions via assign_task, they will automatically work in your worktree.",
    "",
    "### Approval Workflow (MANDATORY)",
    "",
    "1. **When ALL work is complete**, call `request_approval` — it is the **ONLY** path for your changes to reach main. There is no other way.",
    "2. **Immediately after** calling `request_approval`, render a change-summary dashboard with `render_set`:",
    "   - A `text` component summarising what was done and why",
    "   - A `table` component showing files changed (insertions/deletions per file)",
    "   - `metric` components for overall stats: commit count, files changed, lines added, lines removed",
    "   - A `status` component with label \"Approval\" and state \"warning\", content \"Waiting for review\"",
    "3. **Stop and wait.** Do NOT continue working. The user will either:",
    "   - **Click \"Approve & Merge\"** → your changes are merged into main; you're done.",
    "   - **Send a follow-up message** → treat it as a change request: make the modifications in the *same* worktree, then call `request_approval` again.",
    "   - **Click \"Discard\"** → all your changes are thrown away.",
    "4. **After approval (or discard) + a new message**, the server provisions a **fresh worktree**.",
    "   Re-read every file you need — do not assume files from the previous cycle still exist on the new branch.",
  ];
}

/**
 * Append the mandatory worktree-isolation rules to a base system prompt.
 * The orchestrator relies on agents respecting these rules; the addendum
 * is authoritative and should not be paraphrased.
 */
export function enrichSystemPromptForWorktree(
  basePrompt: string,
  worktree: { path: string; branch: string; projectPath: string },
  mode: WorktreePromptMode,
): string {
  const integrationRule = mode.role === "leader" && !mode.canonical
    ? "Your changes go through the worktree and are merged after approval."
    : mode.role === "leader"
      ? "Your contribution stays in the worktree until automatic collection, gates, and lineage integration."
      : mode.sharedWorktree
        ? "Your edits stay in the Leader's worktree for orchestrator-owned integration."
        : "Your changes stay in this worktree for orchestrator-managed integration.";
  const worktreeAddendum = [
    "",
    "",
    "## ⚠️ WORKTREE ISOLATION — ACTIVE",
    "",
    `Your working directory (cwd) is an isolated git worktree:`,
    `  **Worktree path:** \`${worktree.path}\``,
    `  **Branch:** \`${worktree.branch}\``,
    `  **Main project:** \`${worktree.projectPath}\``,
    "",
    "### Rules",
    "",
    "- Make repository changes only inside this worktree and your assigned write scopes; the effective sandbox policy may restrict them further.",
    "- Resolve discovered paths before use. Authorized reference reads may include dependencies, installed skills, and durable handoff sources outside the worktree; those reads do not grant write access.",
    `- Do not mutate the main working tree at \`${worktree.projectPath}\`. ${integrationRule}`,
    "- Run shell commands from the assigned worktree cwd; use the shell/filesystem tools provided by your harness.",
    ...compileWorktreeCompletionPolicy(mode),
    "",
  ].join("\n");
  return basePrompt + worktreeAddendum;
}
