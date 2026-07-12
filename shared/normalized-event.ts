/**
 * NormalizedEvent — the wire format on the WebSocket (Phase 3+) and the
 * persisted payload in event_log.
 *
 * Discriminated by `kind`. Shared between server and client so the contract
 * is exact — both sides import from this file.
 *
 * Design invariants (all harnesses must satisfy):
 *   - `init` is always the first event emitted.
 *   - `done` is always the last event emitted.
 *   - `thinking` is optional; consumers must tolerate its absence.
 *   - `usage.cacheRead` / `cacheCreation` are optional; consumers default to 0.
 *   - `tool_call.parentId` is undefined for top-level calls; sub-agent calls
 *     carry the parent tool-use ID (Anthropic parent_tool_use_id semantics).
 *   - `text_delta.parentId` — same semantics; allows receivers to filter
 *     sub-agent deltas from the parent session's streaming preview.
 *
 * See docs/model-agnosticism-spec.md §3.3 and Phase 3.
 */

import { z } from "zod/v4";

// ── Core event union ──────────────────────────────────────────────────────────

export type NormalizedEvent =
  // ── Spec-defined variants ──────────────────────────────────────────────────
  /**
   * Session initialization — carries sessionId, model, and permission mode.
   * `meta` holds harness-specific init data (e.g. Claude's tools/mcp_servers
   * fields). Consumers that only need the normalised fields ignore it.
   */
  | { kind: "init"; sessionId: string; model: string; permissionMode?: string; meta?: Record<string, unknown> }
  /** Complete text block from an assistant turn. */
  | { kind: "text"; text: string; role: "assistant" | "user" }
  /** Complete thinking block (extended thinking / chain-of-thought). */
  | { kind: "thinking"; text: string }
  /** Tool-call intent — the assistant requesting a tool invocation. */
  | { kind: "tool_call"; id: string; name: string; input: unknown; parentId?: string }
  /** Tool-call result — the harness's response to a tool invocation. */
  | { kind: "tool_result"; callId: string; output: unknown; isError: boolean }
  /** Token + cost accounting for the turn. */
  | {
      kind: "usage";
      source?: "assistant" | "result" | "turn_completed";
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
      costUSD?: number;
      messageId?: string;
      turnId?: string;
      sdkSessionId?: string;
    }
  /** The harness was denied permission to run a tool. */
  | { kind: "permission_denial"; tool: string; reason: string }
  /** Rate limit hit; caller should back off by `retryAfterMs`. */
  | { kind: "rate_limit"; retryAfterMs: number; resetAtMs?: number; message?: string }
  /** Transient API error retried by the harness. */
  | { kind: "api_retry"; attempt: number; reason: string }
  /** Session complete. Final event. */
  | {
      kind: "done";
      reason: "stop" | "abort" | "error" | "completed";
      /** Display-safe error summary. */
      error?: string;
      /** Full diagnostic detail for copy/debug surfaces. */
      fullError?: string;
      /** Result text from a successful completion (mirrors SDK result.result). */
      result?: string;
      /** Total number of turns for the session (mirrors SDK result.num_turns). */
      turns?: number;
      /**
       * Total session cost in USD. Present when the harness provides it on the
       * result message (e.g. Claude SDK total_cost_usd). Absent on abort/error.
       */
      costUSD?: number;
    }

  // ── Sub-agent events (Claude Agent-tool sub-agents) ───────────────────────
  /**
   * A Claude Agent-tool sub-agent task has started. Emitted by ClaudeHarness
   * when it sees a `system/task_started` SDK event. Non-Claude harnesses
   * that have no sub-agent concept never emit this.
   */
  | { kind: "agent_spawned"; taskId: string; description: string }
  /**
   * A Claude Agent-tool sub-agent task has a status update or has completed.
   */
  | { kind: "agent_task_update"; taskId: string; status: string; summary: string }

  // ── Phase 3 extensions for streaming and tool visibility ──────────────────
  /**
   * Incremental text chunk for the active content block.
   * `blockIndex` identifies which content block is streaming; receivers must
   * reset their buffer when the index changes.
   * `parentId` follows tool_call parentId semantics — set on sub-agent deltas
   * so receivers can filter them out of the parent session's preview.
   */
  | { kind: "text_delta"; text: string; blockIndex: number; parentId?: string }
  /** Signals the end of a streaming response. Clears the streaming buffer. */
  | { kind: "stream_end" }
  /**
   * Tool execution in progress — emitted periodically while the harness runs
   * a tool. `elapsedSeconds` is the wall-clock time since the tool started.
   */
  | { kind: "tool_progress"; id: string; name: string; elapsedSeconds: number; parentId?: string };

const usageSchema = z.object({
  kind: z.literal("usage"),
  source: z.enum(["assistant", "result", "turn_completed"]).optional(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheCreation: z.number().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  messageId: z.string().optional(),
  turnId: z.string().optional(),
  sdkSessionId: z.string().optional(),
});

/** Runtime form of the producer/consumer contract used on persisted and WS data. */
export const normalizedEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("init"), sessionId: z.string(), model: z.string(), permissionMode: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional() }),
  z.object({ kind: z.literal("text"), text: z.string(), role: z.enum(["assistant", "user"]) }),
  z.object({ kind: z.literal("thinking"), text: z.string() }),
  z.object({ kind: z.literal("tool_call"), id: z.string(), name: z.string(), input: z.unknown(), parentId: z.string().optional() }),
  z.object({ kind: z.literal("tool_result"), callId: z.string(), output: z.unknown(), isError: z.boolean() }),
  usageSchema,
  z.object({ kind: z.literal("permission_denial"), tool: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("rate_limit"), retryAfterMs: z.number().nonnegative(), resetAtMs: z.number().optional(), message: z.string().optional() }),
  z.object({ kind: z.literal("api_retry"), attempt: z.number().int().positive(), reason: z.string() }),
  z.object({ kind: z.literal("done"), reason: z.enum(["stop", "abort", "error", "completed"]), error: z.string().optional(), fullError: z.string().optional(), result: z.string().optional(), turns: z.number().int().nonnegative().optional(), costUSD: z.number().nonnegative().optional() }),
  z.object({ kind: z.literal("agent_spawned"), taskId: z.string(), description: z.string() }),
  z.object({ kind: z.literal("agent_task_update"), taskId: z.string(), status: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("text_delta"), text: z.string(), blockIndex: z.number().int().nonnegative(), parentId: z.string().optional() }),
  z.object({ kind: z.literal("stream_end") }),
  z.object({ kind: z.literal("tool_progress"), id: z.string(), name: z.string(), elapsedSeconds: z.number().nonnegative(), parentId: z.string().optional() }),
]);

export function parseNormalizedEvent(value: unknown): NormalizedEvent {
  return normalizedEventSchema.parse(value) as NormalizedEvent;
}
