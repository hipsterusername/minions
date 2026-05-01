/**
 * Translate Anthropic SDK messages → NormalizedEvent[].
 *
 * One SDKMessage can produce zero, one, or many NormalizedEvents:
 *   - system/init       → [init]
 *   - system/api_retry  → [api_retry]
 *   - assistant         → [thinking?, text*, tool_call*] + [usage]
 *   - result (success)  → [usage] + [permission_denial*] + [done]
 *   - result (error)    → [done]
 *   - rate_limit_event  → [rate_limit]
 *   - everything else   → []
 *
 * This is a pure function with no side effects. All SDK coupling lives here.
 *
 * Phase 1: new module, not yet wired into session-host.ts.
 * See docs/model-agnosticism-spec.md §3.3 and Phase 1.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedEvent } from "../types.ts";

// ── Internal content-block shape ──────────────────────────────────────────────
// We only inspect the fields Minions cares about. A narrower local type avoids
// importing BetaContentBlock from the Anthropic SDK's deep type tree.

interface RawBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// ── Main translator ───────────────────────────────────────────────────────────

/**
 * Convert one SDK message to zero or more NormalizedEvents.
 *
 * The result array may be empty (e.g. for stream_event partials, tool_progress,
 * and other SDK messages that Minions doesn't surface as discrete events).
 */
export function sdkToNormalized(msg: SDKMessage): NormalizedEvent[] {
  switch (msg.type) {
    case "system":
      return translateSystem(msg as SystemLike);

    case "assistant":
      return translateAssistant(msg as AssistantLike);

    case "result":
      return translateResult(msg as ResultLike);

    case "rate_limit_event":
      return translateRateLimit(msg as RateLimitLike);

    default:
      return [];
  }
}

// ── Per-type helpers ──────────────────────────────────────────────────────────

// Minimal structural shapes — we cast from SDKMessage to avoid deep SDK imports.

interface SystemLike {
  type: "system";
  subtype: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
  attempt?: number;
  error?: string;
}

interface AssistantLike {
  type: "assistant";
  parent_tool_use_id: string | null;
  message: {
    content: RawBlock[];
    usage?: RawUsage;
  };
}

interface ResultLike {
  type: "result";
  is_error: boolean;
  subtype?: string;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  usage?: RawUsage;
  permission_denials?: Array<{ tool_name: string }>;
}

interface RateLimitLike {
  type: "rate_limit_event";
  rate_limit_info?: { resetsAt?: number };
}

function translateSystem(msg: SystemLike): NormalizedEvent[] {
  if (msg.subtype === "init") {
    return [
      {
        kind: "init",
        sessionId: msg.session_id ?? "",
        model: msg.model ?? "",
        permissionMode: msg.permissionMode,
      },
    ];
  }

  if (msg.subtype === "api_retry") {
    return [
      {
        kind: "api_retry",
        attempt: msg.attempt ?? 1,
        reason: msg.error ?? "unknown",
      },
    ];
  }

  return [];
}

function translateAssistant(msg: AssistantLike): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const parentId = msg.parent_tool_use_id ?? undefined;

  for (const block of msg.message.content) {
    if (block.type === "thinking" && block.thinking) {
      events.push({ kind: "thinking", text: block.thinking });
    } else if (block.type === "text" && block.text) {
      events.push({ kind: "text", text: block.text, role: "assistant" });
    } else if (block.type === "tool_use" && block.id && block.name) {
      events.push({
        kind: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
        parentId,
      });
    }
  }

  if (msg.message.usage) {
    events.push(usageFromRaw(msg.message.usage, undefined));
  }

  return events;
}

function translateResult(msg: ResultLike): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  if (msg.is_error) {
    const error = msg.errors?.[0] ?? "Unknown error";
    events.push({ kind: "done", reason: "error", error });
    return events;
  }

  if (msg.usage) {
    events.push(usageFromRaw(msg.usage, msg.total_cost_usd));
  }

  for (const denial of msg.permission_denials ?? []) {
    events.push({ kind: "permission_denial", tool: denial.tool_name, reason: "denied" });
  }

  events.push({ kind: "done", reason: "completed" });
  return events;
}

function translateRateLimit(msg: RateLimitLike): NormalizedEvent[] {
  const resetsAt = msg.rate_limit_info?.resetsAt;
  const retryAfterMs = resetsAt ? Math.max(0, resetsAt * 1000 - Date.now()) : 0;
  return [{ kind: "rate_limit", retryAfterMs }];
}

function usageFromRaw(u: RawUsage, costUSD: number | undefined): NormalizedEvent {
  return {
    kind: "usage",
    input: u.input_tokens,
    output: u.output_tokens,
    ...(u.cache_read_input_tokens != null && { cacheRead: u.cache_read_input_tokens }),
    ...(u.cache_creation_input_tokens != null && { cacheCreation: u.cache_creation_input_tokens }),
    ...(costUSD != null && { costUSD }),
  };
}
