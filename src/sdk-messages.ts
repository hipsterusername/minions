/**
 * NormalizedEvent → display message conversion.
 *
 * Phase 3: operates on NormalizedEvent (discriminated by `kind`) rather than
 * the legacy SdkMessage union. Each NormalizedEvent maps to zero or more
 * DisplayMessages shown in the chat feed.
 *
 * ID generation strategy:
 *   - For events with a natural ID (tool_call.id, tool_progress.id): use it
 *     to produce a stable, deterministic message ID.
 *   - For text/thinking/done/init: derive a semi-stable key from content so
 *     the same event processed twice produces the same message ID and
 *     deduplication in the session-stream reducer works correctly.
 *   - For everything else: use `msgId(prefix)` (random UUID).
 */

import type { NormalizedEvent } from "../shared/normalized-event.ts";

// ── Display message (rendered in both Leader & Minion nodes) ──

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "result" | "thinking";
  content: string;
  timestamp: number;
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  /** e.g. "8.6s · $0.0288" */
  suffix?: string | undefined;
  /** SDK message UUID — used for deduplication */
  sdkUuid?: string | undefined;
  /**
   * Optional metadata for result messages. Set on error results so
   * consumers can apply error styling independently of the role field.
   */
  meta?: { isError?: boolean; error?: string } | undefined;
}

// ── Helpers ────────────────────────────────────────────

export function msgId(prefix = "m"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatRateLimitMessage(event: Extract<NormalizedEvent, { kind: "rate_limit" }>): string {
  const waitSec = event.retryAfterMs > 0 ? Math.ceil(event.retryAfterMs / 1000) : 0;
  const waitText = waitSec > 0 ? `resuming in ${waitSec}s` : "";
  if (event.resetAtMs && Number.isFinite(event.resetAtMs)) {
    const resetAt = new Date(event.resetAtMs).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `Rate limited until ${resetAt}${waitText ? ` (${waitText})` : ""}`;
  }
  return `Rate limited${waitText ? `; ${waitText}` : ""}`;
}

/**
 * Derive a semi-stable, URL-safe key from content so that the same event
 * produces the same message ID when processed twice (enabling dedup).
 */
function stableKey(content: string): string {
  // Take the first 40 chars, replace non-word chars with underscores.
  return content.slice(0, 40).replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
}

function derivedId(prefix: string, kind: string, key: string): string {
  return `${prefix}-${kind}-${stableKey(key)}`;
}

/**
 * Convert a NormalizedEvent into zero or more DisplayMessages for the chat
 * feed. Returns an empty array for events that don't produce UI output.
 *
 * Mapping:
 *   init       → system "Session on <model>"
 *   text/asst  → assistant (strips task-name markers; drops if empty)
 *   thinking   → thinking
 *   tool_call  → tool (top-level only; parentId calls dropped)
 *   tool_progress → tool (top-level only; parentId calls dropped)
 *   done/error → result with error text
 *   done/completed → result with result text (if non-empty)
 *   api_retry  → system "Retrying..."
 *   rate_limit → system "Rate limited..."
 *   permission_denial → system "Permission denied: <tool>"
 *   everything else (usage, text_delta, stream_end, tool_result) → []
 */
export function normalizedToDisplayMessages(
  event: NormalizedEvent,
  prefix = "m",
): DisplayMessage[] {
  const now = Date.now();

  switch (event.kind) {
    case "init":
      return [{
        id: derivedId(prefix, "init", event.model),
        role: "system",
        content: `Session on ${event.model}`,
        timestamp: now,
      }];

    case "text": {
      if (event.role !== "assistant") return [];
      const text = event.text.replace(/<!--task-name:.+?-->\s*/g, "");
      if (!text.trim()) return [];
      return [{
        id: derivedId(prefix, "text", text),
        role: "assistant",
        content: text,
        timestamp: now,
      }];
    }

    case "thinking":
      return [{
        id: derivedId(prefix, "think", event.text),
        role: "thinking",
        content: event.text,
        timestamp: now,
      }];

    case "tool_call": {
      if (event.parentId != null) return [];
      return [{
        id: `${prefix}-call-${event.id}`,
        role: "tool",
        content: event.name,
        timestamp: now,
        toolName: event.name,
        toolInput: event.input as Record<string, unknown>,
      }];
    }

    case "tool_progress": {
      if (event.parentId != null) return [];
      return [{
        id: `${prefix}-prog-${event.id}`,
        role: "tool",
        content: `${event.name} (${event.elapsedSeconds.toFixed(1)}s)`,
        timestamp: now,
        toolName: event.name,
      }];
    }

    case "done": {
      if (event.reason === "error") {
        const errText = event.error ?? "Error";
        return [{
          id: derivedId(prefix, "done-err", errText),
          role: "result",
          content: errText,
          timestamp: now,
          meta: { isError: true, error: errText },
        }];
      }
      if (event.reason === "completed" || event.reason === "stop") {
        if (!event.result) return [];
        const txt = event.result.replace(/<!--task-name:.+?-->\s*/g, "");
        if (!txt.trim()) return [];
        return [{
          id: derivedId(prefix, "done-ok", txt),
          role: "result",
          content: txt,
          timestamp: now,
        }];
      }
      return [];
    }

    case "api_retry":
      return [{
        id: msgId(prefix),
        role: "system",
        content: `Retrying (attempt ${event.attempt}): ${event.reason}`,
        timestamp: now,
      }];

    case "rate_limit": {
      return [{
        id: msgId(prefix),
        role: "system",
        content: formatRateLimitMessage(event),
        timestamp: now,
      }];
    }

    case "permission_denial":
      return [{
        id: derivedId(prefix, "perm", event.tool),
        role: "system",
        content: `Permission denied: ${event.tool}`,
        timestamp: now,
      }];

    // usage, text_delta, stream_end, tool_result → no display
    default:
      return [];
  }
}
