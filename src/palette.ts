// ── Centralized color palette ──────────────────────────────
// Single source of truth for semantic colors used in components.
// All values read from CSS custom properties, so they respond to theme changes.
// Import these maps instead of hardcoding hex values in components.

/** Read a CSS variable from :root at call time. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// ── Status colors ────────────────────────────────────────────

export type SessionStatus =
  | "disconnected"
  | "waiting"
  | "creating"
  | "running"
  | "idle"
  | "stopped"
  | "error";

/** Status color map — always reads current theme values. */
export function getStatusColor(status: string): string {
  return cssVar(`--status-${status}`, "#6b7190");
}

/** Static status color map for non-reactive use (snapshot at import time). */
export const STATUS_COLORS: Record<SessionStatus, string> = {
  disconnected: "var(--status-disconnected)",
  waiting: "var(--status-waiting)",
  creating: "var(--status-creating)",
  running: "var(--status-running)",
  idle: "var(--status-idle)",
  stopped: "var(--status-stopped)",
  error: "var(--status-error)",
};

// ── Priority colors ──────────────────────────────────────────

export type Priority = "critical" | "high" | "medium" | "low";

export function getPriorityColor(priority: string): string {
  return cssVar(`--priority-${priority}`, "#6b7280");
}

export const PRIORITY_COLORS: Record<Priority, string> = {
  critical: "var(--priority-critical)",
  high: "var(--priority-high)",
  medium: "var(--priority-medium)",
  low: "var(--priority-low)",
};

// ── Task status colors ───────────────────────────────────────

export type TaskStatus = "planned" | "in_progress" | "completed" | "failed";

export function getTaskStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "var(--status-success)";
    case "in_progress":
      return "var(--status-warning)";
    case "failed":
      return "var(--status-error)";
    default:
      return "var(--text-muted)";
  }
}

// ── Model colors ─────────────────────────────────────────────

export type ModelKey = "sonnet" | "opus" | "haiku";

export const MODEL_COLORS: Record<ModelKey, string> = {
  sonnet: "var(--model-sonnet)",
  opus: "var(--model-opus)",
  haiku: "var(--model-haiku)",
};

// ── Common semantic aliases (CSS var references) ─────────────

export const COLORS = {
  // Text
  textPrimary: "var(--text-primary)",
  textSecondary: "var(--text-secondary)",
  textMuted: "var(--text-muted)",

  // Backgrounds
  bgPrimary: "var(--bg-primary)",
  bgSecondary: "var(--bg-secondary)",
  bgSurface: "var(--bg-surface)",
  bgElevated: "var(--bg-elevated)",

  // Borders
  borderDefault: "var(--border-default)",
  borderHover: "var(--border-hover)",

  // Semantic
  accent: "var(--accent)",
  accentDark: "var(--accent-dark)",
  success: "var(--success-color)",
  danger: "var(--danger-color)",
  dangerText: "var(--danger-color-text)",
  warning: "var(--warning-color)",
  info: "var(--info-color)",

  // Shadows
  shadowSm: "var(--shadow-sm)",
  shadowMd: "var(--shadow-md)",
  shadowLg: "var(--shadow-lg)",
  overlayBg: "var(--overlay-bg)",

  // Hover/active states
  stateHover: "var(--state-hover)",
  stateActive: "var(--state-active)",

  // Tool/thinking
  toolAccent: "var(--tool-accent)",
  toolBg: "var(--tool-bg)",
  toolBgHover: "var(--tool-bg-hover)",
  thinkingAccent: "var(--thinking-accent)",
  thinkingBg: "var(--thinking-bg)",
  thinkingBgHover: "var(--thinking-bg-hover)",
  successBg: "var(--success-bg)",
  dangerBg: "var(--danger-bg)",
  warningBg: "var(--warning-bg)",
  codeBg: "var(--code-bg)",

  // Streaming
  streaming: "var(--streaming-color)",

  // Edges
  edgeTask: "var(--edge-task)",
  edgeStatus: "var(--edge-status)",
  edgeContext: "var(--edge-context)",
} as const;
