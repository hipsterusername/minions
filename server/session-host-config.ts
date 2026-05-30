/**
 * Static configuration + type definitions used by `SessionHost`.
 *
 * Extracted from `session-host.ts` to keep the host class file under the
 * 400-line architecture ceiling. Contains:
 *   - Shared type aliases (roles, statuses, buffered events)
 *   - Adaptive-thinking config + validation
 *   - `deriveTaskName` prompt helper
 *   - Buffer cap constant
 *
 * None of this module holds state — everything exported is a pure value
 * or a pure function.
 */

// ── Buffer cap ─────────────────────────────────────────────

export const MAX_BUFFERED_EVENTS = 200;

import type { NormalizedEvent } from "./harness/types.ts";

// ── Shared types ───────────────────────────────────────────

export type SessionRole = "leader" | "minion" | "default" | "card-composer";

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
   * For type="sdk_event" (Phase 3+): the normalized event payload.
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
  "opus",
  "opus-old",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
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

// ── System prompt enrichment ───────────────────────────────

/**
 * Append the mandatory worktree-isolation rules to a base system prompt.
 * The orchestrator relies on agents respecting these rules; the addendum
 * is authoritative and should not be paraphrased.
 */
export function enrichSystemPromptForWorktree(
  basePrompt: string,
  worktree: { path: string; branch: string; projectPath: string },
  isMinion: boolean,
): string {
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
    "- **ALL file operations (Read, Write, Edit, Glob, Grep) MUST target paths within your worktree directory.**",
    "- When you discover file paths (from Glob, Grep, error messages, git output, etc.), they will already be within your worktree — use them as-is.",
    `- **NEVER** use paths under \`${worktree.projectPath}\` directly — that is the user's main working tree. Your changes go through the worktree and are merged after approval.`,
    "- Bash commands automatically run in your worktree cwd.",
    ...(isMinion
      ? [
          "- **Commit your work** (`git add -A && git commit -m \"...\"`) before calling `report_done`. The orchestrator has an auto-commit fallback, but explicit commits produce cleaner history.",
          "- **Do NOT** create branches, merge, rebase, or push — the orchestrator manages all integration.",
        ]
      : [
          "- If you spawn subagents via the Agent tool, they inherit your worktree cwd.",
          "- When delegating to minions via assign_task, they will automatically work in your worktree.",
        ]),
    "",
  ].join("\n");
  return basePrompt + worktreeAddendum;
}
