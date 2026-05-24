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
