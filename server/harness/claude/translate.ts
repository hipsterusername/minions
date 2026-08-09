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
 *   - stream_event      → [text_delta] or [stream_end] or []
 *   - tool_progress     → [tool_progress]
 *   - everything else   → []
 *
 * This is a pure function with no side effects. All SDK coupling lives here.
 *
 * Translates Claude SDK messages into the shared normalized event contract.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedEvent } from "../types.ts";
import { tagTerminalProvenance } from "../terminal-provenance.ts";

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

type UsageSource = NonNullable<Extract<NormalizedEvent, { kind: "usage" }>["source"]>;

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

    case "stream_event":
      return translateStreamEvent(msg as StreamEventLike);

    case "tool_progress":
      return translateToolProgress(msg as ToolProgressLike);

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
  uuid?: string;
  session_id?: string;
  parent_tool_use_id: string | null;
  message: {
    id?: string;
    content: RawBlock[];
    usage?: RawUsage;
  };
}

interface ResultLike {
  type: "result";
  uuid?: string;
  session_id?: string;
  is_error: boolean;
  subtype?: string;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  num_turns?: number;
  usage?: RawUsage;
  permission_denials?: Array<{ tool_name: string }>;
}

interface RateLimitLike {
  type: "rate_limit_event";
  rate_limit_info?: { resetsAt?: number };
}

interface StreamEventLike {
  type: "stream_event";
  parent_tool_use_id?: string | null;
  event: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; text?: string };
  };
}

interface ToolProgressLike {
  type: "tool_progress";
  tool_use_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string | null;
  elapsed_time_seconds?: number;
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
  if (!msg.message?.content) return [];
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
    const messageId = msg.message.id ?? msg.uuid;
    events.push(usageFromRaw(msg.message.usage, {
      source: "assistant",
      messageId,
      sdkSessionId: msg.session_id,
    }));
  }

  return events;
}

function translateResult(msg: ResultLike): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  if (msg.is_error) {
    const error = msg.errors?.[0] ?? "Unknown error";
    if (isClaudeToolUseDiagnostic(error)) {
      return translateSuccessfulResult(msg, events);
    }
    events.push(tagTerminalProvenance(
      { kind: "done", reason: "error", error },
      "provider",
    ));
    return events;
  }

  return translateSuccessfulResult(msg, events);
}

function translateSuccessfulResult(
  msg: ResultLike,
  events: NormalizedEvent[] = [],
): NormalizedEvent[] {
  if (msg.usage) {
    events.push(usageFromRaw(msg.usage, {
      source: "result",
      messageId: msg.uuid,
      sdkSessionId: msg.session_id,
      costUSD: msg.total_cost_usd,
    }));
  }

  for (const denial of msg.permission_denials ?? []) {
    events.push({ kind: "permission_denial", tool: denial.tool_name, reason: "denied" });
  }

  events.push(tagTerminalProvenance({
    kind: "done",
    reason: "completed",
    ...(msg.result != null && { result: msg.result }),
    ...(msg.num_turns != null && { turns: msg.num_turns }),
    // Include total cost on done so processNormalizedEvent can capture it even
    // when result carries total_cost_usd but no usage breakdown.
    ...(msg.total_cost_usd != null && { costUSD: msg.total_cost_usd }),
  }, "provider"));
  return events;
}

export function isClaudeToolUseDiagnostic(error: string): boolean {
  return (
    error.includes("[ede_diagnostic]") &&
    error.includes("result_type=user") &&
    error.includes("last_content_type=n/a") &&
    error.includes("stop_reason=tool_use")
  );
}

function translateRateLimit(msg: RateLimitLike): NormalizedEvent[] {
  const resetsAt = msg.rate_limit_info?.resetsAt;
  const resetAtMs = resetsAt ? resetsAt * 1000 : undefined;
  const retryAfterMs = resetAtMs ? Math.max(0, resetAtMs - Date.now()) : 0;
  return [
    {
      kind: "rate_limit",
      retryAfterMs,
      ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    },
  ];
}

function usageFromRaw(
  u: RawUsage,
  meta: {
    source: UsageSource;
    costUSD?: number | undefined;
    messageId?: string | undefined;
    turnId?: string | undefined;
    sdkSessionId?: string | undefined;
  },
): NormalizedEvent {
  return {
    kind: "usage",
    source: meta.source,
    input: u.input_tokens,
    output: u.output_tokens,
    ...(u.cache_read_input_tokens != null && { cacheRead: u.cache_read_input_tokens }),
    ...(u.cache_creation_input_tokens != null && { cacheCreation: u.cache_creation_input_tokens }),
    ...(meta.costUSD != null && { costUSD: meta.costUSD }),
    ...(meta.messageId != null && { messageId: meta.messageId }),
    ...(meta.turnId != null && { turnId: meta.turnId }),
    ...(meta.sdkSessionId != null && { sdkSessionId: meta.sdkSessionId }),
  };
}

function translateStreamEvent(msg: StreamEventLike): NormalizedEvent[] {
  const { event } = msg;
  const parentId = msg.parent_tool_use_id ?? undefined;
  const index = typeof event.index === "number" ? event.index : 0;

  if (event.type === "content_block_delta") {
    const delta = event.delta;
    // text_delta carries a new text chunk for the active content block.
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return [{ kind: "text_delta", text: delta.text, blockIndex: index, parentId }];
    }
    // Some SDK versions omit delta.type but still carry delta.text.
    if (!delta?.type && typeof delta?.text === "string") {
      return [{ kind: "text_delta", text: delta.text, blockIndex: index, parentId }];
    }
    // input_json_delta, thinking_delta, etc. — not surfaced as streaming events.
    return [];
  }

  if (event.type === "content_block_start" && event.content_block?.type === "text") {
    // Initial text for a new text block — treat as an empty-or-prefilled delta.
    const initial = event.content_block.text ?? "";
    return initial ? [{ kind: "text_delta", text: initial, blockIndex: index, parentId }] : [];
  }

  if (event.type === "message_stop") {
    return [{ kind: "stream_end" }];
  }

  return [];
}

function translateToolProgress(msg: ToolProgressLike): NormalizedEvent[] {
  const parentId = msg.parent_tool_use_id ?? undefined;
  return [
    {
      kind: "tool_progress",
      id: msg.tool_use_id ?? "",
      name: msg.tool_name ?? "",
      elapsedSeconds: msg.elapsed_time_seconds ?? 0,
      ...(parentId !== undefined && { parentId }),
    },
  ];
}

/**
 * Accepts an opaque `unknown` value so callers outside the harness directory
 * can translate SDK messages without importing `SDKMessage` directly.
 * Internally casts to `SDKMessage`; all SDK coupling stays in this file.
 */
export function translateSdkMessage(msg: unknown): NormalizedEvent[] {
  return sdkToNormalized(msg as SDKMessage);
}
