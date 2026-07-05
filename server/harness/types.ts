/**
 * Core types for the AgentHarness abstraction.
 *
 * Defines the seam between Minions and any LLM agent harness:
 * the AgentHarness interface, normalized event/tool types, and
 * per-harness capability flags.
 *
 * Phase 0: types only, no callers yet.
 * Phase 3: NormalizedEvent moved to shared/normalized-event.ts so both
 *          server and client can import it from the same source.
 * See docs/model-agnosticism-spec.md §3 for the full design rationale.
 */

import type { ZodTypeAny } from "zod/v4";

// Re-export the canonical type so server-internal code that was importing
// NormalizedEvent from here continues to work unchanged.
import type { NormalizedEvent } from "../../shared/normalized-event.ts";
export type { NormalizedEvent } from "../../shared/normalized-event.ts";

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
  /**
   * Whether the harness ships built-in filesystem tools (Read, Write, Edit,
   * Bash, etc.) via a local binary. True for ClaudeHarness (claude-code
   * executable); false for harnesses that rely purely on MCP tools.
   *
   * Replaces the `harness.name === "claude"` check in session-host-run.ts
   * so callers branch on capability, not identity.
   */
  builtInFilesystem: boolean;
}

// ── Start options ─────────────────────────────────────────────────────────────

/** A normalized user message for multi-turn input streams. */
export interface NormalizedUserMessage {
  role: "user";
  content: string;
}

/**
 * Normalized binary attachment for the first user turn. Each harness
 * consumes this in its own native format — Claude builds an SDK image
 * content block, Codex writes the bytes to a temp file and passes a
 * `local_image` UserInput. Other harnesses ignore the field.
 */
export interface NormalizedAttachment {
  kind: "image";
  filename?: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Pure base64 payload — no `data:` prefix. */
  data: string;
}

/**
 * Normalized permission-mode strings shared across harnesses. Each harness
 * maps these to its native concept — Claude uses them as-is for its
 * `permissionMode` SDK option; Codex maps to `approvalPolicy` /
 * `sandboxMode`. Harnesses that lack a permission concept ignore the field.
 */
export type NormalizedPermissionMode =
  | "default"
  | "auto"
  | "bypassPermissions"
  | "plan";

/** Options passed to AgentHarness.start(). */
export interface HarnessStartOptions {
  /**
   * Stable per-session identity. Required by harnesses that need to scope
   * external resources to a session (e.g. the Codex MCP bridge route and the
   * Codex attachment scratch directory). Harnesses that need no per-session
   * identity (Claude, Echo) may ignore it. Populated from `SessionHost.id`
   * in `buildHarnessStartOpts`.
   */
  sessionKey: string;
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
   * Pre-wrapped MCP server objects from user-configured external servers
   * (e.g. sidecar mcp-servers.json). Typed as `unknown` because each harness
   * uses its own native server type. Non-MCP harnesses ignore this field.
   */
  externalMcpServers?: Record<string, unknown>;
  /**
   * Thinking configuration. Only consulted when capabilities.thinking is true.
   * Harnesses that do not support thinking ignore this field entirely.
   */
  thinking?: {
    effort: "low" | "medium" | "high";
    display: "summarized" | "omitted";
  };
  /**
   * Multimodal attachments riding on the first user turn. Each harness
   * consumes them in its own native format. Optional; harnesses that do
   * not support attachments ignore the field.
   */
  attachments?: ReadonlyArray<NormalizedAttachment>;
  /**
   * Normalized permission mode. Claude uses this verbatim as its SDK
   * `permissionMode`; Codex maps it to `approvalPolicy` / `sandboxMode`.
   * Harnesses that lack a permission concept ignore the field.
   */
  permissionMode?: NormalizedPermissionMode;
}

// ── Normalized tool types ─────────────────────────────────────────────────────

/** Result returned by a normalized tool handler. */
export interface NormalizedToolResult {
  /** Content blocks — matches the current MCP wire shape. */
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * MCP/App tool safety annotations. These hints let hosts distinguish
 * read-only lookups from state-changing actions and frame approval prompts
 * correctly. Defaults are supplied by harness adapters when omitted.
 */
export interface NormalizedToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
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
  /** Optional MCP/App safety hints advertised in tools/list descriptors. */
  annotations?: NormalizedToolAnnotations;
  handler: (input: unknown) => Promise<NormalizedToolResult>;
}

// ── Run control + static info ─────────────────────────────────────────────────

/**
 * Per-run, harness-neutral control surface. Returned alongside the event
 * stream from `AgentHarness.start()` so command handlers can act on the
 * live run without reaching into harness-specific SDK objects.
 *
 * Every method except `abort` is optional — a harness implements only the
 * subset it natively supports. Command handlers must check for the method's
 * presence and return the spec's "<command>" is not supported by harness
 * "<name>" error when it is missing. A missing optional method must never
 * throw.
 */
export interface HarnessRunControl {
  /** Idempotent. Cancels the in-flight run. */
  abort(): void;
  /** Tear down the underlying SDK handle (Claude `query.close`). */
  close?(): Promise<void>;
  /** Cancel the in-flight turn without ending the session. */
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  getContextUsage?(): Promise<unknown>;
  getUsageReport?(): Promise<unknown>;
  mcpServerStatus?(): Promise<unknown>;
  rewindFiles?(args: {
    userMessageId: string;
    dryRun?: boolean | undefined;
  }): Promise<unknown>;
  seedReadState?(args: { path: string; mtime: number }): Promise<unknown>;
  stopTask?(taskId: string): Promise<unknown>;
  reconnectMcpServer?(serverName: string): Promise<unknown>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<unknown>;
}

/**
 * Static, run-independent introspection a harness can answer without an
 * active session. Used by info-query commands (`get_supported_models`,
 * `get_supported_commands`, `get_supported_agents`, `get_account_info`)
 * so they keep working when no run is live.
 */
export interface HarnessStaticInfo {
  /** Model ids the harness can resolve, in display order. */
  models: ReadonlyArray<{ id: string; label: string }>;
  /** Slash-style commands surfaced by the harness, if any. */
  commands: ReadonlyArray<{ name: string; description: string }>;
  /** Sub-agent definitions the harness exposes, if any. */
  agents: ReadonlyArray<{ id: string; description: string }>;
  /** Provider/account info; opaque to the UI beyond `provider`. */
  account: { provider: string } & Record<string, unknown>;
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
   * Built-in tool names the harness makes available to the agent without
   * any MCP server registration — e.g. the Claude Code built-in file tools.
   *
   * The session host adds these to `allowedTools` alongside the MCP tool
   * names so the agent knows which tools it may call. Harnesses that do not
   * expose built-in tools return an empty array.
   *
   * Phase 5: replaces the hard-coded `CODE_TOOLS` constant in
   * `server/session-host-run.ts`.
   */
  readonly builtInTools: string[];

  /**
   * Start the session. Returns the event stream the host pulls until the
   * `done` event is emitted, plus a per-run control surface command
   * handlers route through. Must emit `init` first and `done` last on the
   * event stream. The pair is returned atomically so callers can assign
   * both fields in one statement and clear both on `done`.
   */
  start(opts: HarnessStartOptions): {
    events: AsyncIterable<NormalizedEvent>;
    control: HarnessRunControl;
  };

  /**
   * Static introspection for the harness. Run-independent; safe to call
   * before, during, and after `start()`. Used by info-query commands so
   * they work even when no run is live.
   */
  staticInfo(): HarnessStaticInfo;

  /**
   * Optional run-independent usage report for provider/account state.
   * Harnesses should implement this only when they can answer without a live
   * session control object. Live per-run usage still belongs on
   * HarnessRunControl.getUsageReport().
   */
  getUsageReport?(): Promise<unknown>;

  /**
   * Register tool definitions, grouped by MCP server name.
   * Called before start(). The harness stores the groups internally and
   * wraps them into its native tool format during start().
   *
   * Keys become MCP server names so tool call names follow the pattern
   * `mcp__<serverName>__<toolName>` (matching the allowedTools list).
   * Harnesses without native MCP flatten the groups and dispatch by tool name.
   */
  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void;

  /**
   * Map a user-supplied alias ("opus", "sonnet", "small", "fast") to a
   * concrete model ID. Returns null if the alias is unknown to this harness —
   * callers should surface a clear error on null.
   */
  resolveModel(alias: string): string | null;
}
