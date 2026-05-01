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

// ── Core event union ──────────────────────────────────────────────────────────

export type NormalizedEvent =
  // ── Spec-defined variants ──────────────────────────────────────────────────
  /** Session initialization — carries sessionId, model, and permission mode. */
  | { kind: "init"; sessionId: string; model: string; permissionMode?: string }
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
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
      costUSD?: number;
    }
  /** The harness was denied permission to run a tool. */
  | { kind: "permission_denial"; tool: string; reason: string }
  /** Rate limit hit; caller should back off by `retryAfterMs`. */
  | { kind: "rate_limit"; retryAfterMs: number; message?: string }
  /** Transient API error retried by the harness. */
  | { kind: "api_retry"; attempt: number; reason: string }
  /** Session complete. Final event. */
  | {
      kind: "done";
      reason: "stop" | "abort" | "error" | "completed";
      error?: string;
      /** Result text from a successful completion (mirrors SDK result.result). */
      result?: string;
      /** Total number of turns for the session (mirrors SDK result.num_turns). */
      turns?: number;
    }

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
