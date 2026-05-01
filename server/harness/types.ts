/**
 * Core types for the AgentHarness abstraction.
 *
 * Defines the seam between Minions and any LLM agent harness:
 * the AgentHarness interface, normalized event/tool types, and
 * per-harness capability flags.
 *
 * Phase 0: types only, no callers yet.
 * See docs/model-agnosticism-spec.md §3 for the full design rationale.
 */

import type { ZodTypeAny } from "zod/v4";

// ── Capability flags ──────────────────────────────────────────────────────────

/**
 * Static feature flags declared by a harness. The orchestrator branches on
 * these values, not on the harness name — see spec §4.
 */
export interface HarnessCapabilities {
  /** Whether adaptive/extended thinking blocks are supported. */
  thinking: boolean;
  /** Whether cache_read / cache_creation token accounting is supported. */
  promptCaching: boolean;
  /** Whether the harness speaks native MCP (vs. a function-calling shim). */
  mcp: boolean;
  /** Whether the harness can defer tool calls to a permission prompt. */
  permissionPrompts: boolean;
  /** Whether the harness can resume by session ID. */
  resume: boolean;
  /** Whether the harness emits content_block_delta-style streaming partials. */
  partialMessages: boolean;
}

// ── Start options ─────────────────────────────────────────────────────────────

/** A normalized user message for multi-turn input streams. */
export interface NormalizedUserMessage {
  role: "user";
  content: string;
}

/** Options passed to AgentHarness.start(). */
export interface HarnessStartOptions {
  /** Working directory for the agent session. */
  cwd: string;
  /** Initial prompt string or async stream of user turns. */
  prompt: string | AsyncIterable<NormalizedUserMessage>;
  /** System prompt for this session. */
  systemPrompt: string;
  /** Concrete model ID, already resolved via resolveModel(). */
  model: string;
  /** Built-in tool names the harness may invoke. */
  allowedTools: string[];
  /** Signal to abort the running session. */
  abortSignal: AbortSignal;
  /** Optional session ID for resume (harness-opaque string). */
  resumeId?: string;
  /**
   * Thinking configuration. Only consulted when capabilities.thinking is true.
   * Harnesses that do not support thinking ignore this field entirely.
   */
  thinking?: {
    effort: "low" | "medium" | "high";
    display: "summarized" | "omitted";
  };
}

// ── Normalized event union ────────────────────────────────────────────────────

/**
 * Normalized event union — the wire format on the WebSocket (Phase 3+) and
 * the persisted payload in event_log. Discriminated by `kind`.
 *
 * Invariants (all harnesses must satisfy):
 *   - `init` is always the first event emitted.
 *   - `done` is always the last event emitted.
 *   - `thinking` events are optional; consumers must tolerate their absence.
 *   - `usage.cacheRead` / `cacheCreation` are optional; consumers default to 0.
 *   - `tool_call.parentId` is undefined for top-level calls; sub-agent calls
 *     carry the parent tool-use ID (Anthropic parent_tool_use_id semantics).
 */
export type NormalizedEvent =
  | { kind: "init"; sessionId: string; model: string; permissionMode?: string }
  | { kind: "text"; text: string; role: "assistant" | "user" }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown; parentId?: string }
  | { kind: "tool_result"; callId: string; output: unknown; isError: boolean }
  | {
      kind: "usage";
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
      costUSD?: number;
    }
  | { kind: "permission_denial"; tool: string; reason: string }
  | { kind: "rate_limit"; retryAfterMs: number; message?: string }
  | { kind: "api_retry"; attempt: number; reason: string }
  | { kind: "done"; reason: "stop" | "abort" | "error" | "completed"; error?: string };

// ── Normalized tool types ─────────────────────────────────────────────────────

/** Result returned by a normalized tool handler. */
export interface NormalizedToolResult {
  /** Content blocks — matches the current MCP wire shape. */
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Harness-agnostic tool definition. Each harness translates this to its native
 * format inside registerTools().
 *
 *   Claude  → createSdkMcpServer / tool() via server/harness/claude/tools.ts
 *   OpenAI  → function-calling JSON schema + in-process dispatch table
 *
 * Zod is the canonical schema language; harnesses that need JSON Schema call
 * zodToJsonSchema(def.inputSchema) internally.
 */
export interface NormalizedToolDef {
  /** Tool name, e.g. "plan_task". */
  name: string;
  description: string;
  /** Zod schema — the single source of truth, converted per-harness. */
  inputSchema: ZodTypeAny;
  handler: (input: unknown) => Promise<NormalizedToolResult>;
}

// ── AgentHarness interface ────────────────────────────────────────────────────

/**
 * The seam between Minions and any LLM agent harness.
 *
 * A harness owns: model selection, the chat/query loop, tool registration,
 * abort, and resume. It owns nothing about the canvas, bus, persistence,
 * worktree, or UI.
 *
 * Implementations live under server/harness/<name>/index.ts and register
 * themselves via server/harness/index.ts registerHarness() on import.
 */
export interface AgentHarness {
  /** Stable harness name, e.g. "claude", "codex", "pi". */
  readonly name: string;

  /** Static feature flags. Branch on these, not on name. */
  readonly capabilities: HarnessCapabilities;

  /**
   * Start the session. Returns an AsyncIterable the host pulls until the
   * `done` event is emitted. Must emit `init` first and `done` last.
   */
  start(opts: HarnessStartOptions): AsyncIterable<NormalizedEvent>;

  /** Abort the running session. Idempotent — safe to call multiple times. */
  abort(): void;

  /**
   * Translate normalized tool definitions into whatever format this harness
   * expects. Called before start(). The harness stores the result internally
   * and uses it during the query loop.
   */
  registerTools(defs: NormalizedToolDef[]): void;

  /**
   * Map a user-supplied alias ("opus", "sonnet", "small", "fast") to a
   * concrete model ID. Returns null if the alias is unknown to this harness —
   * callers should surface a clear error on null.
   */
  resolveModel(alias: string): string | null;
}
