/**
 * Pure helpers for grouping and displaying LeaderNode messages.
 *
 * No React imports — all functions are plain TypeScript so they can be
 * tested without a DOM environment.
 */

import type { DisplayMessage } from "../sdk-messages.ts";

// LeaderMessage is an alias for the shared DisplayMessage type.
type LeaderMessage = DisplayMessage;

// ── Message grouping ──────────────────────────────────────────────────────────

export type LeaderMessageGroup =
  | { kind: "single"; msg: LeaderMessage }
  | { kind: "tool-group"; msgs: LeaderMessage[] }
  | { kind: "thinking-group"; msgs: LeaderMessage[] };

/**
 * Collapse consecutive tool messages into tool-groups and consecutive
 * thinking messages into thinking-groups. All other messages are single
 * entries. Order of messages is preserved within each group.
 */
export function groupMessages(messages: LeaderMessage[]): LeaderMessageGroup[] {
  const groups: LeaderMessageGroup[] = [];
  let toolBatch: LeaderMessage[] = [];
  let thinkingBatch: LeaderMessage[] = [];

  const flushTools = () => {
    if (toolBatch.length > 0) {
      groups.push({ kind: "tool-group", msgs: [...toolBatch] });
      toolBatch = [];
    }
  };

  const flushThinking = () => {
    if (thinkingBatch.length > 0) {
      groups.push({ kind: "thinking-group", msgs: [...thinkingBatch] });
      thinkingBatch = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      flushThinking();
      toolBatch.push(msg);
    } else if (msg.role === "thinking") {
      flushTools();
      thinkingBatch.push(msg);
    } else {
      flushTools();
      flushThinking();
      groups.push({ kind: "single", msg });
    }
  }
  flushTools();
  flushThinking();
  return groups;
}

// ── Tool-call noise filtering ─────────────────────────────────────────────────
//
// Tool messages from the SDK fall into two buckets:
//
//   1. **Pure plumbing** — set_task_name, get_task_status, wait_and_continue,
//      render_set/patch/append/remove, TodoWrite. These either mutate other
//      surfaces (the Dashboard tab, the task plan section, the wait countdown
//      in the toolbar) or are zero-payload queries. Showing them in a chat
//      transcript is just noise; the same info is already on screen.
//
//   2. **Substantive work** — Read, Edit, Bash, Grep, Glob, Write, plan_task,
//      assign_task, complete_task, etc. These have user-relevant payloads
//      (filenames, commands, task titles). We *keep* them but consolidate
//      consecutive runs into a single grouped chip so a long Read/Edit
//      sequence doesn't drown the transcript.
//
// Naming: the SDK delivers MCP-registered tools as `mcp__<server>__<tool>`
// so we match both the bare name and the prefix.

const HIDDEN_TOOL_BARE_NAMES = new Set<string>([
  "set_task_name",
  "get_task_status",
  "wait_and_continue",
  "render_set",
  "render_patch",
  "render_append",
  "render_remove",
  "TodoWrite",
]);

const HIDDEN_MCP_PREFIXES = ["mcp__render-dashboard__"];

/** Whether a tool call is pure plumbing that should be hidden from transcripts. */
export function isHiddenTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  // Strip mcp__server__ prefix if present so "mcp__task-manager__set_task_name"
  // matches "set_task_name" in the bare set.
  const bare = toolName.includes("__")
    ? toolName.slice(toolName.lastIndexOf("__") + 2)
    : toolName;
  if (HIDDEN_TOOL_BARE_NAMES.has(bare)) return true;
  return HIDDEN_MCP_PREFIXES.some((p) => toolName.startsWith(p));
}

/** Strip `mcp__server__` for display so chips read cleanly. */
export function shortToolName(toolName: string): string {
  return toolName.includes("__")
    ? toolName.slice(toolName.lastIndexOf("__") + 2)
    : toolName;
}

function bareToolName(toolName: string): string {
  return shortToolName(toolName);
}

// ── Tool icon map ─────────────────────────────────────────────────────────────

export const TOOL_ICONS: Record<string, string> = {
  Read: "▷",
  Write: "▶",
  Edit: "✎",
  Bash: "$",
  Glob: "✱",
  Grep: "/",
  Agent: "✦",
  WebFetch: "↗",
  WebSearch: "⌕",
};

// ── Tool input formatting ─────────────────────────────────────────────────────

/**
 * Extract the most readable summary field from a tool's input for inline
 * display. Returns `null` when there is nothing meaningful to show.
 */
export function formatToolInput(
  toolName: string,
  input?: Record<string, unknown>,
): string | null {
  if (!input || Object.keys(input).length === 0) return null;

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return (input["file_path"] as string) ?? null;
    case "Bash":
      return (input["command"] as string) ?? null;
    case "Glob":
    case "Grep":
      return (input["pattern"] as string) ?? null;
    case "Agent":
      return (input["description"] as string) ?? (input["prompt"] as string) ?? null;
    case "WebFetch":
      return (input["url"] as string) ?? null;
    case "WebSearch":
      return (input["query"] as string) ?? null;
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
      return null;
    }
  }
}

export interface ToolDisplayInfo {
  icon: string;
  label: string;
  shortLabel: string;
  kind: "file" | "search" | "shell" | "web" | "delegate" | "review" | "context" | "tool";
  summary: string | null;
}

const FRIENDLY_TOOL_LABELS: Record<string, Omit<ToolDisplayInfo, "summary">> = {
  Read: { icon: "R", label: "Read file", shortLabel: "Read", kind: "file" },
  Write: { icon: "W", label: "Write file", shortLabel: "Write", kind: "file" },
  Edit: { icon: "E", label: "Edit file", shortLabel: "Edit", kind: "file" },
  Bash: { icon: "$", label: "Run command", shortLabel: "Command", kind: "shell" },
  Glob: { icon: "*", label: "Find files", shortLabel: "Files", kind: "search" },
  Grep: { icon: "/", label: "Search code", shortLabel: "Search", kind: "search" },
  Agent: { icon: "A", label: "Delegate agent", shortLabel: "Agent", kind: "delegate" },
  WebFetch: { icon: "W", label: "Fetch web page", shortLabel: "Fetch", kind: "web" },
  WebSearch: { icon: "S", label: "Search web", shortLabel: "Web", kind: "web" },
  plan_task: { icon: "P", label: "Plan task", shortLabel: "Plan", kind: "delegate" },
  assign_task: { icon: "M", label: "Launch minion", shortLabel: "Minion", kind: "delegate" },
  message_task: { icon: "M", label: "Message minion", shortLabel: "Message", kind: "delegate" },
  complete_task: { icon: "C", label: "Complete task", shortLabel: "Complete", kind: "review" },
  cancel_task: { icon: "X", label: "Cancel task", shortLabel: "Cancel", kind: "review" },
  get_task_status: { icon: "?", label: "Check task", shortLabel: "Status", kind: "context" },
  wait_and_continue: { icon: "T", label: "Wait", shortLabel: "Wait", kind: "context" },
};

function taskSummary(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  for (const key of ["title", "taskId", "message", "reason", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function toolDisplayInfo(
  toolName: string | undefined | null,
  input?: Record<string, unknown>,
): ToolDisplayInfo {
  const raw = toolName ?? "tool";
  const bare = bareToolName(raw);
  const friendly = FRIENDLY_TOOL_LABELS[bare];
  const summary = taskSummary(input) ?? formatToolInput(bare, input) ?? formatToolInput(raw, input);
  if (friendly) return { ...friendly, summary };
  const label = bare.replace(/_/g, " ");
  return {
    icon: TOOL_ICONS[bare] ?? "•",
    label,
    shortLabel: label,
    kind: "tool",
    summary,
  };
}

/**
 * Format all tool input fields as `key: value` lines for the detail
 * view. Returns `"(no input)"` when the input is absent or empty.
 */
export function formatToolInputDetail(input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "(no input)";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    lines.push(`${k}: ${val}`);
  }
  return lines.join("\n");
}

// ── Time formatting ───────────────────────────────────────────────────────────

/**
 * Human-readable relative timestamp: `"3s ago"`, `"5m ago"`, `"2h ago"`.
 * Always clamps to zero — future timestamps display as `"0s ago"`.
 */
export function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
