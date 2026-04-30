# Model Agnosticism — Spec

**Status:** Draft. Not yet implemented.
**Companion documents:** [`testing-strategy.md`](./testing-strategy.md), the project `CLAUDE.md`.
**Owner:** TBD.

---

## 1. Why this exists

Today Minions is welded to `@anthropic-ai/claude-agent-sdk`. There is one
hard dependency, and that dependency reaches into 14 server files plus the
React/streaming layer (~11 sites that pattern-match on Anthropic content
blocks). The repo cannot host a non-Claude harness — `pi`, OpenAI Codex,
Aider, a local `llama.cpp` runner — without rewriting the session loop, the
MCP tool factory, the wire format, and parts of the UI.

The good news from the audit (see Appendix A) is that the rot is
concentrated, not diffuse. Four hard ties drive almost everything:

1. The `query()` async-generator loop in `server/session-host.ts:322`.
2. The Anthropic content-block shape leaking from SDK → bus → SQLite → React
   with no normalization layer.
3. The SDK-bespoke `createSdkMcpServer` / `tool()` helpers used to build
   every Minions tool — these are not the standard
   `@modelcontextprotocol/sdk` API.
4. Anthropic-only options on `query()`: `permissionMode`, adaptive
   `thinking`, `pathToClaudeCodeExecutable`, plus first-class
   `cache_read_input_tokens` / `cache_creation_input_tokens` in usage
   accounting.

This spec defines a single seam — `AgentHarness` — that isolates those four
ties behind one interface, and a phased migration that lands the seam
without behavior change before any second harness is attempted.

---

## 2. Goals (and non-goals)

**Goals.**

1. One named, typed seam between Minions and any LLM agent harness.
2. Today's Claude harness keeps working bit-for-bit through Phase 1 — no
   regressions in the existing 839-test suite.
3. Adding a second harness (e.g. `pi` or Codex) is a self-contained PR that
   touches only `server/harness/<name>/` and a small capability registry,
   not the rest of the codebase.
4. Per-harness capability differences (no prompt caching, no thinking, no
   MCP, different permission models) are expressed as data, not as
   conditional branches sprinkled through the codebase.
5. The wire format on the WebSocket and the persisted event payloads stop
   being raw Anthropic SDK shapes. They become a normalized event union
   that all harnesses can produce.

**Non-goals.**

- Shipping a second harness in this spec. That is follow-on work; this spec
  delivers only the seam and the Claude implementation.
- Rewriting the worktree, approval, persistence schema, or dashboard DSL.
  Those layers are already harness-agnostic and stay as-is.
- Supporting harnesses that do not speak tool-calling at all. Minions'
  whole architecture (leader/minion/MCP) assumes structured tool use; a
  pure text-completion harness is out of scope.
- Backwards-compatible dual wire formats. Per the project rule
  "replace, don't deprecate," when the normalized event union lands the
  raw SDK-shape WS payload is removed in the same PR.

---

## 3. The seam: `AgentHarness`

A harness is a class that runs one agent session and emits a stream of
normalized events. It owns nothing about the canvas, the bus, persistence,
the worktree, or the UI. It owns: model selection, the chat/query loop,
tool registration, abort, and resume.

### 3.1 Module layout

```
server/harness/
  index.ts                    // Harness registry + factory
  types.ts                    // AgentHarness, NormalizedEvent, capabilities
  claude/
    index.ts                  // ClaudeHarness implements AgentHarness
    translate.ts              // SdkMessage → NormalizedEvent
    tools.ts                  // createSdkMcpServer adapter for normalized tool defs
    models.ts                 // moved from session-host-config.ts
  // future:
  // codex/
  // pi/
```

Architecture-fitness rule (extends `tests/architecture/`): no file outside
`server/harness/claude/` may import from `@anthropic-ai/claude-agent-sdk`.
Today, 14 files do; after Phase 2, exactly one does
(`server/harness/claude/index.ts`).

### 3.2 The interface

```ts
export interface AgentHarness {
  /** Stable harness name, e.g. "claude", "codex", "pi". */
  readonly name: string;

  /** Static feature flags. The orchestrator branches on this, not on `name`. */
  readonly capabilities: HarnessCapabilities;

  /** Start the session. Returns an AsyncIterable the host pulls until done. */
  start(opts: HarnessStartOptions): AsyncIterable<NormalizedEvent>;

  /** Abort the running session. Idempotent. */
  abort(): void;

  /**
   * Translate a normalized tool definition into whatever this harness
   * actually wants. For Claude this calls createSdkMcpServer/tool().
   * For Codex this returns OpenAI function-calling JSON schemas.
   * The return type is `unknown` because each harness consumes it
   * privately during start().
   */
  registerTools(defs: NormalizedToolDef[]): void;

  /**
   * Map a user-supplied alias ("opus", "sonnet", "small", "fast") to a
   * concrete model ID. Returns null if the alias is unknown to this
   * harness — the caller should surface a clear error.
   */
  resolveModel(alias: string): string | null;
}

export interface HarnessCapabilities {
  thinking: boolean;          // adaptive/extended thinking blocks
  promptCaching: boolean;     // cache_read / cache_creation token accounting
  mcp: boolean;               // native MCP, not function-calling shim
  permissionPrompts: boolean; // can defer tool calls to a permission prompt
  resume: boolean;            // can resume by session ID
  partialMessages: boolean;   // emits content_block_delta-style streaming
}

export interface HarnessStartOptions {
  cwd: string;
  prompt: string | AsyncIterable<NormalizedUserMessage>;
  systemPrompt: string;
  model: string;              // already resolved by resolveModel()
  allowedTools: string[];     // built-in tool names; harness validates
  abortSignal: AbortSignal;
  resumeId?: string;
  /** Harness-specific extras gated by capabilities. */
  thinking?: { effort: "low" | "medium" | "high"; display: "summarized" | "omitted" };
}
```

### 3.3 The normalized event union

This is the wire format on the WS (Phase 3) and the persisted payload
(Phase 3 onward). It is a discriminated union with one discriminant
(`kind`), not Anthropic's two-level `type` / inner `content[].type` layout.

```ts
export type NormalizedEvent =
  | { kind: "init"; sessionId: string; model: string; permissionMode?: string }
  | { kind: "text"; text: string; role: "assistant" | "user" }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown; parentId?: string }
  | { kind: "tool_result"; callId: string; output: unknown; isError: boolean }
  | { kind: "usage"; input: number; output: number; cacheRead?: number; cacheCreation?: number; costUSD?: number }
  | { kind: "permission_denial"; tool: string; reason: string }
  | { kind: "rate_limit"; retryAfterMs: number; message?: string }
  | { kind: "api_retry"; attempt: number; reason: string }
  | { kind: "done"; reason: "stop" | "abort" | "error" | "completed"; error?: string };
```

Design rules:

- Every harness must produce `init` first and `done` last. Everything in
  between is optional.
- `thinking` events from harnesses that don't support thinking are simply
  never emitted; consumers tolerate absence.
- `usage.cacheRead` / `cacheCreation` are optional; consumers must default
  to zero, not crash.
- `tool_call.parentId` carries Anthropic's `parent_tool_use_id` semantics
  for sub-agent isolation. Harnesses without nested tool sessions leave
  it undefined; consumers treat `undefined` as "top-level."

### 3.4 The normalized tool def

```ts
export interface NormalizedToolDef {
  name: string;                              // e.g. "plan_task"
  description: string;
  inputSchema: ZodTypeAny;                   // Zod is the canonical source
  handler: (input: unknown) => Promise<NormalizedToolResult>;
}

export interface NormalizedToolResult {
  content: Array<{ type: "text"; text: string }>; // current MCP shape
  isError?: boolean;
}
```

Each harness translates this to its native tool format inside
`registerTools`. For Claude that means walking the array and calling
`tool(name, description, zodToJsonSchema(inputSchema), handler)` then
bundling them into `createSdkMcpServer({ name, tools })`. For Codex it
means `{ type: "function", function: { name, description, parameters: zodToJsonSchema(inputSchema) } }`
plus a local handler dispatch table.

Today, every Minions tool already follows this shape — they just import
`tool` from the SDK directly. The migration is mechanical.

---

## 4. Layer-by-layer impact map

| Layer | File(s) today | Change |
|---|---|---|
| Session host | `server/session-host.ts`, `session-host-run.ts`, `session-host-config.ts` | Replace `query()` import with `harness.start()`. Move model alias table into `server/harness/claude/models.ts`. |
| MCP tool definitions | `server/task-tools.ts`, `server/task-tools/*.ts`, `server/minion-tools.ts`, `server/render-tools.ts`, `server/routines/step-tools.ts` | Stop importing `createSdkMcpServer`/`tool` directly. Each tool becomes a `NormalizedToolDef` literal; the harness wraps them. |
| WS bus | `server/bus.ts`, `shared/ws-envelope.ts` | `sdk_event` payload changes from `SdkMessage` to `NormalizedEvent`. Add a schema test that pins the new shape. |
| Persistence | `server/db.ts`, `server/session-persist.ts` | `event_log.payload` becomes `NormalizedEvent` JSON. New schema version; old rows are migrated by re-encoding (Phase 3) or dropped (acceptable — event_log is a transient replay buffer, not durable history). |
| Client receive | `src/use-socket.ts` | Drop `ContentBlock` / `TextBlock` / `ToolUseBlock` / `ToolResultBlock`. Replace with `NormalizedEvent`. |
| Display conversion | `src/sdk-messages.ts`, `src/streaming.ts` | Rewrite around `NormalizedEvent.kind` instead of `block.type`. |
| Node components | `src/nodes/ClaudeSessionNode.tsx`, `LeaderNode.tsx`, `src/CardCreationChat.tsx`, `src/components/StatusBanner.tsx`, `src/session-stream.ts` | Replace every `type === 'tool_use' \| 'thinking' \| 'text'` discriminant with `kind === 'tool_call' \| 'thinking' \| 'text'`. |
| Usage accounting | `src/usage-aggregator.ts` | Make `cacheRead` / `cacheCreation` optional; default to zero. |
| Prompts | `src/prompts/*.ts` | Stop hardcoding tool names by string. Read them from the harness's `allowedTools` list and interpolate. |
| Dashboard, skills, worktree, approval | `src/render-dsl.ts`, `src/skills/`, `server/worktree-*.ts`, `server/commands/approve-changes.ts` | **No change.** Already harness-agnostic. |
| `.claude-canvas/` sidecar | `server/{skills,routine-store,session-persist,project-store}.ts` | Rename to `.minions/` with a one-version migration (see §6). |

---

## 5. Phased migration

Each phase is one PR. Each PR ships its own tests in the same commit, per
the project working agreement. No phase changes user-visible behavior
except Phase 7 (rename).

### Phase 0 — Types and registry, no callers

**Adds:**
- `server/harness/types.ts` with the interface, capabilities, normalized
  event/tool types.
- `server/harness/index.ts` with a registry map keyed by name and a
  default-resolver that errors loudly on unknown harness.
- Colocated unit tests for the registry.

**Touches no existing code.** Cost: ~1 day.

**Acceptance:** `pnpm verify` green. New tests in the suite. Zero diff in
behavior or wire format.

### Phase 1 — `ClaudeHarness` wraps today's loop

**Adds:**
- `server/harness/claude/index.ts` implementing `AgentHarness` against
  `query()`.
- `server/harness/claude/translate.ts` with one pure function
  `sdkToNormalized(msg: SdkMessage): NormalizedEvent[]` (one SDK message
  can produce multiple events — e.g. an assistant message with text +
  thinking + tool_use yields three).
- `server/harness/claude/tools.ts` with one pure function
  `wrapTools(defs: NormalizedToolDef[]): McpServerInstance` calling
  `createSdkMcpServer`/`tool` exactly the way the existing code does.
- `server/harness/claude/models.ts` containing the alias map moved from
  `session-host-config.ts`.

**Touches:** nothing yet — the existing `session-host.ts` still calls
`query()` directly. The Claude harness exists in parallel and is exercised
only by its own unit tests.

**Acceptance:**
- Unit tests for `sdkToNormalized` cover every variant of `SdkMessage`
  used in production today (system/init, content blocks, tool_use,
  tool_result, message_stop, rate_limit_event, api_retry, completion,
  abort).
- Unit tests for `wrapTools` confirm the produced MCP server is
  structurally identical to the current per-file wiring (compare
  `server.tools.length`, names, schemas).
- `pnpm verify` green. No behavior change.

Cost: ~2 days.

### Phase 2 — Cut `session-host.ts` over to the harness

**Changes:**
- `server/session-host.ts` no longer imports `@anthropic-ai/claude-agent-sdk`.
  It depends only on the registry: `getHarness(opts.harness ?? "claude")`.
- The `for await (msg of handle)` loop is replaced with
  `for await (const evt of harness.start(...))` — the iterator yields
  normalized events directly.
- `session-host-run.ts::processSdkMessage` is replaced by
  `processNormalizedEvent`. **However:** the bus payload at this stage
  still contains the *original* `SdkMessage` to keep the WS contract
  stable. The harness's translate step happens, but we re-encode back
  out for the WS until Phase 3 flips it. (This is a one-PR-of-overlap
  ugliness, but it lets Phase 2 land without touching the client.)

  Concretely: the harness yields normalized events; the host fans out
  *both* a normalized stream (for new code) and the legacy SDK shape (for
  the bus, until Phase 3). The legacy shape is kept by giving each
  normalized event a `_raw: SdkMessage` private back-pointer, scoped to
  this transitional phase only.

  *Alternative considered:* land Phases 2 and 3 as one PR. Rejected —
  the diff is too large to review safely against an 839-test surface.

**Architecture test added:**
`tests/architecture/no-claude-sdk-outside-harness.test.ts` — fails CI if
any file outside `server/harness/claude/` imports from
`@anthropic-ai/claude-agent-sdk`.

**Acceptance:** `pnpm verify` green. Existing client-side tests pass
unmodified. Manual smoke: open a leader session, run a minion task,
approve, merge. No visible difference.

Cost: ~2 days.

### Phase 3 — Flip the WS and persistence to normalized events

**Changes:**
- `shared/ws-envelope.ts`: the `sdk_event` topic payload type changes
  from `SdkMessage` to `NormalizedEvent`.
- `server/bus.ts`: serializes normalized events.
- `server/session-persist.ts` + `server/db.ts`: writes normalized events
  into `event_log.payload`. Add a `schema_version` column on `event_log`
  defaulting to `2`; rows from version `1` are dropped on read (event_log
  is a 5-minute replay buffer, not durable history — explicitly OK per §6).
- The `_raw` back-pointer from Phase 2 is deleted.
- `src/use-socket.ts`: `ContentBlock` and friends are deleted. New
  `NormalizedEvent` type imported from `shared/normalized-event.ts`
  (a new file shared between server and client to keep the contract
  exact).
- `src/sdk-messages.ts` and `src/streaming.ts` are rewritten around
  `kind` instead of `block.type`.
- Every component listed in §4 has its discriminants updated.

**Contract test added:** `tests/contracts/normalized-event.test.ts` —
loads the shared schema and asserts every harness-produced event round-trips
through the WS envelope.

**Acceptance:**
- Every existing client test that switched on `block.type === 'tool_use'`
  is rewritten to `evt.kind === 'tool_call'`. Per the working agreement
  in `CLAUDE.md`, if the rewritten test cannot pass on the new code
  unchanged, behavior has drifted and we stop.
- Manual smoke: same as Phase 2, plus a round-trip of a session with
  thinking blocks, sub-agent tool calls, and a rate-limit event.

Cost: ~3–5 days. This is the largest PR.

### Phase 4 — Harness-agnostic tool registration

**Changes:**
- Each `server/task-tools/*.ts`, `server/minion-tools.ts`,
  `server/render-tools.ts`, `server/routines/step-tools.ts`:
  - Stop importing `createSdkMcpServer`/`tool`.
  - Export a `NormalizedToolDef` (or array of them) — pure data, no SDK
    coupling.
- `server/session-host-run.ts`: collects all tool defs and passes the
  flat list to `harness.registerTools(...)`. The Claude harness wraps
  them via the existing `tools.ts` from Phase 1.

**Acceptance:** Every existing tool unit test still passes. The
architecture test added in Phase 2 is now satisfied: only
`server/harness/claude/tools.ts` calls into the SDK helpers.

Cost: ~3–4 days. Mechanical but spans many files.

### Phase 5 — Capabilities flags

**Changes:**
- `server/session-host-run.ts`: `permissionMode`, `thinking`, and
  `pathToClaudeCodeExecutable` are no longer set unconditionally.
  Each is gated by `harness.capabilities.permissionPrompts` /
  `.thinking` / (Claude-only).
- `src/usage-aggregator.ts`: `cacheReadInputTokens` /
  `cacheCreationInputTokens` become optional, default-zero.
- `CODE_TOOLS` constant in `session-host-run.ts:41` becomes a per-harness
  property: `harness.builtInTools`. The Claude harness keeps today's
  list; future harnesses declare their own.

**Acceptance:** `pnpm verify` green. Behavior unchanged for Claude.

Cost: ~1 day.

### Phase 6 — Prompts read tool names from the harness

**Changes:**
- `src/prompts/leader-system.ts`, `minion-system.ts`,
  `card-creation-system.ts`: stop hardcoding "Read, Write, Edit, Bash,
  Glob, Grep, WebFetch, WebSearch" by string. Accept a `tools: string[]`
  parameter and interpolate it.
- Server callers pass `harness.builtInTools` when building the prompt.

**Acceptance:** Snapshot the rendered prompt for the Claude harness; it
must equal today's prompt. Add a parallel test for a fake harness with a
different tool list.

Cost: ~1 day.

### Phase 7 — `.claude-canvas/` → `.minions/`

**Changes:**
- `server/{skills,routine-store,session-persist,project-store}.ts`: the
  sidecar dir constant is renamed.
- One-time migration on server boot: if `.claude-canvas/` exists and
  `.minions/` does not, rename it. If both exist, log a warning and use
  `.minions/`. Per the project rule "replace, don't deprecate," the
  `.claude-canvas/` fallback read path is removed in this PR.
- The user-global SQLite DB at `~/.claude-canvas/server.db` is renamed
  to `~/.minions/server.db` with the same one-time migration.

**Acceptance:** Boot test asserts the migration runs once and is
idempotent. Manual: existing project still loads after upgrade.

Cost: ~½ day.

### Phase 8 — Add a second harness (out of scope for this spec)

Spec for a `CodexHarness` or `PiHarness` is its own document, written
once Phases 0–7 ship. Sketch:

- Implement `AgentHarness` against the OpenAI Responses API or the local
  process.
- Map the harness's streaming events to `NormalizedEvent`.
- Translate `NormalizedToolDef` to OpenAI function-calling schemas (or
  whatever pi accepts).
- Set `capabilities` truthfully — most non-Anthropic harnesses set
  `thinking: false`, `promptCaching: false`.
- Register in `server/harness/index.ts`.

If Phases 0–7 are correctly scoped, this is a self-contained PR that
touches only `server/harness/<name>/` and the registry.

---

## 6. Notes on the hard calls

### 6.1 Why no compatibility shim for the WS payload

The project rule is "replace, don't deprecate." Phase 3 changes the WS
contract in one PR, and the client is updated in the same PR. Browsers
load the new client immediately on refresh; there is no long-lived
client/server version skew to support. Keeping a dual format would
double the surface every consumer pattern-matches on, which is exactly
the bug we are fixing.

### 6.2 Why dropping old `event_log` rows is OK

`event_log` is a replay buffer with `MAX_BUFFERED_EVENTS = 200` per
session. It exists so a reconnecting client can rebuild recent state. It
is not the durable record of a session — that is the `sessions` table
plus the SDK's own resume mechanism. Dropping rows from schema version
`1` on the Phase 3 boot means a user mid-session at the moment of
upgrade loses the last few minutes of in-memory chat replay; their
session itself is intact and resumes fine.

### 6.3 Why Zod stays the canonical schema language

Today every MCP tool's input schema is a Zod object. Zod converts cleanly
to JSON Schema (for OpenAI function calling) and to MCP's expected
format. Replacing it would force every existing tool to rewrite, for no
benefit. Harnesses that need JSON Schema call `zodToJsonSchema(def.inputSchema)`
inside their own `registerTools`.

### 6.4 What about prompt caching specifically?

Anthropic's prompt caching is a token-accounting concern (the
`cache_read_input_tokens` / `cache_creation_input_tokens` fields) plus a
provider-side optimization (no client API surface — the SDK opts in
automatically). For non-Anthropic harnesses both fields are simply
absent; the aggregator (Phase 5) defaults them to zero. No further
abstraction required.

### 6.5 What about adaptive thinking?

The `thinking: { type: "adaptive", effort, display }` option on
`query()` is Anthropic-only. It moves into the Claude harness
constructor as an internal default and is exposed on
`HarnessStartOptions.thinking` only when `capabilities.thinking` is true.
The leader UI's "thinking effort" picker checks the active harness's
capabilities and hides itself when unsupported.

### 6.6 What about the worktree + approval flow?

It survives unchanged. `server/worktree-*.ts`, `server/commands/approve-changes.ts`,
and `server/task-tools/request-approval.ts` are pure git + bus code and
do not touch the SDK. The only adjustment is that `request-approval`
becomes a `NormalizedToolDef` like every other tool in Phase 4.

---

## 7. Testing

Per `docs/testing-strategy.md` and `CLAUDE.md`, every phase ships its
tests in the same commit.

| Layer | Phase | Test type | Location |
|---|---|---|---|
| Registry, types | 0 | Colocated unit | `server/harness/index.test.ts` |
| `sdkToNormalized` translator | 1 | Colocated unit, table-driven | `server/harness/claude/translate.test.ts` |
| `wrapTools` adapter | 1 | Colocated unit | `server/harness/claude/tools.test.ts` |
| No SDK imports outside `server/harness/claude/` | 2 | Architecture fitness | `tests/architecture/no-claude-sdk-outside-harness.test.ts` |
| WS payload shape (`NormalizedEvent`) | 3 | Contract | `tests/contracts/normalized-event.test.ts` |
| Persistence schema v2 | 3 | Colocated unit | `server/session-persist.test.ts` |
| Client component discriminants | 3 | Colocated component | next to each touched file |
| Usage aggregator with absent cache fields | 5 | Colocated unit | `src/usage-aggregator.test.ts` |
| Prompt rendering with arbitrary tool list | 6 | Colocated unit | `src/prompts/leader-system.test.ts` etc. |
| Sidecar migration | 7 | Colocated unit | `server/project-store.test.ts` |

The refactor rule from `CLAUDE.md` applies throughout: write the test
that captures today's behavior, confirm it passes on today's code,
refactor, the same test passes unchanged. If a test must be edited, the
behavior changed — stop and call it out in the PR.

---

## 8. Open questions

These deserve answers before Phase 0 is opened, but they do not block
the spec.

1. **Resume semantics across harnesses.** Today's `resumeId` is the SDK's
   own session ID. Codex's Responses API has its own response ID;
   `pi`-style local harnesses may have nothing. Should `resumeId` be an
   opaque per-harness string (current proposal), or should we maintain
   our own session log and rebuild context client-side? Proposal:
   opaque per-harness string for now; revisit if we add a harness with
   no native resume.

2. **MCP transport for non-MCP-native harnesses.** Codex has no MCP. If
   Minions wants to expose its tools to a Codex-driven session, the
   Codex harness wraps each `NormalizedToolDef` as a function-calling
   schema and dispatches calls to the same handler in-process. This
   works because all our MCP servers are in-process anyway
   (`createSdkMcpServer`, not external transports). Confirm this holds
   if/when external MCP servers are ever added to a session.

3. **Permission model.** Claude's `permissionMode: "auto"` means the
   model auto-approves tool calls within `allowedTools`. Most other
   harnesses just call whatever they're told. Proposal: drop
   `permissionMode` from `HarnessStartOptions` entirely; let each
   harness apply its own default. The capabilities flag
   `permissionPrompts` exists only so the UI knows whether to render an
   approval queue.

4. **Cost reporting.** The Claude SDK reports a USD cost on result
   messages. OpenAI does not — costs are computed client-side from
   token counts and a price table. Proposal: `usage.costUSD` is
   optional in `NormalizedEvent`; harnesses without native cost
   reporting compute it from a per-model price map and emit it.

5. **Streaming partials.** `query({ includePartialMessages: true })`
   gives us mid-message deltas. Codex SSE is similar; some local
   harnesses are not. The `partialMessages` capability gates whether the
   UI renders streaming text or waits for full assistant turns.

---

## 9. Out of scope for this spec

- Multi-harness sessions (a leader on Claude orchestrating minions on
  Codex, etc.). Plausible after Phase 8 but not designed here.
- Replacing Zod with JSON Schema as the canonical tool schema language.
- A user-facing "harness picker" UI. Until a second harness exists,
  there is nothing to pick.
- Renaming `ClaudeSessionNode.tsx` to `SessionNode.tsx`. Cosmetic and can
  follow Phase 8.
- Removing `pathToClaudeCodeExecutable` from the user environment
  documentation. The Claude harness still needs the binary; non-Claude
  harnesses simply do not consult that env var.

---

## Appendix A — Audit summary

Source: model-agnosticism audit performed against the repo.

| Surface | File(s) | Tie | Phase that fixes it |
|---|---|---|---|
| `query()` loop | `server/session-host.ts:322` | HARD | 2 |
| MCP factory (`createSdkMcpServer`/`tool`) | 11 files in `server/` | HARD | 4 |
| Content-block leak (`tool_use`, `text`, `thinking` discriminants) | `src/use-socket.ts:65–127`, `src/sdk-messages.ts`, `src/streaming.ts`, `src/CardCreationChat.tsx`, `src/components/StatusBanner.tsx`, `src/nodes/{LeaderNode,ClaudeSessionNode}.tsx`, `src/session-stream.ts` | HARD | 3 |
| `tool_use_id` / `parent_tool_use_id` | `src/use-socket.ts`, `src/streaming.ts:125` | HARD | 3 |
| Cache-token fields | `src/usage-aggregator.ts`, `src/use-socket.ts:115` | HARD | 5 |
| `event_log.payload` raw SDK shape | `server/db.ts`, `server/session-persist.ts:215` | HARD | 3 |
| `permissionMode: "auto"` | `server/session-host-run.ts:152` | HARD | 5 |
| Adaptive thinking config | `server/session-host-config.ts:44–104` | HARD | 5 |
| `pathToClaudeCodeExecutable` | `buildQueryOptions` | HARD | 5 |
| `CODE_TOOLS` allowlist | `server/session-host-run.ts:41` | SOFT | 5 |
| Model alias map | `server/session-host-config.ts:62–82` | SOFT | 1 |
| System prompts (tool names by string) | `src/prompts/{leader,minion,card-creation}-system.ts` | SOFT | 6 |
| Worktree + approval | `server/worktree-*.ts`, `server/commands/approve-changes.ts`, `server/task-tools/request-approval.ts` | already abstract | — |
| Skills system | `src/skills/`, `server/skills.ts` | already abstract | — |
| Dashboard DSL | `src/render-dsl.ts`, `server/render-tools.ts` | already abstract | — |
| `.claude-canvas/` sidecar | `server/{skills,routine-store,session-persist,project-store}.ts` | cosmetic | 7 |
| Auth | (none in code; SDK owns it) | needs new env per harness | 8 |
