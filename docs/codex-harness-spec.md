# Codex Harness Extension Spec

**Status:** Phases A/B complete; Phase C is next (updated 2026-05-10)
**Scope:** add a Codex-backed `AgentHarness` alongside the existing Claude harness.

## Executive Summary

`feat/model-agnosticism` introduced the right seam: `AgentHarness`, `NormalizedEvent`,
`NormalizedToolDef`, a Claude adapter, and an `echo` harness. Phases A and B have
now made that seam load-bearing for the current app:

1. **Phase A is complete.** `AgentHarness.start()` returns `{ events, control }`,
   `SessionHost` stores `eventStream` + `runControl`, commands route through
   `HarnessRunControl`, static info moved to `AgentHarness.staticInfo()`, and
   `pnpm verify` gates `server/tsconfig.json`.
2. **Phase B is complete.** `harness` flows through `WsCommand.create_session`,
   is validated against the harness registry, is persisted as `harness_name`,
   is hydrated on restart, is inherited by minions by default, and is exposed in
   both `sync_session` and `session_list` as `harness` + `harnessCapabilities`.
   `send_message` intentionally ignores any per-turn harness override and uses
   the host's existing `harnessName`.
3. **Phase C is next.** The MCP bridge must exist before Codex starts, because
   Codex runs through its own process/config and cannot call the Claude SDK's
   in-process `createSdkMcpServer` objects.
4. **Phase D adds Codex.** The Codex-specific surface remains
   `server/harness/codex/`; the bridge, persistence, commands, sync payloads,
   and session/minion plumbing are shared substrate for every future harness.

## Source Materials

### Local code audited

- `server/harness/types.ts` — `AgentHarness`, `HarnessCapabilities`, `HarnessStartOptions`, `HarnessRunControl`, `HarnessStaticInfo`, `NormalizedToolDef`.
- `server/harness/index.ts` — registry (`registerHarness`, `getHarness`, `registeredHarnessNames`).
- `server/harness/claude/{index,translate,tools,models}.ts` — Claude adapter.
- `server/harness/echo/index.ts` — minimal second harness (registers on import).
- `server/session-host.ts` — `SessionHost`, `StartSessionOptions` (already has optional `harness?: string`).
- `server/session-host-run.ts` — `ensureWorktree`, `buildHarnessStartOpts`, `processNormalizedEvent`.
- `server/session-host-config.ts` — `BufferedEvent`, `SessionStatus`, `ThinkingConfig`.
- `server/session-persist.ts`, `server/session-repo.ts`, `server/db.ts` — SQLite write-through; `sessions.harness_name` is present and hydrated.
- `server/commands/*` — command handlers now route live-run operations through `host.runControl` and static info through `harness.staticInfo()`.
- `server/agents/{leader,minion,types}.ts` — `AgentToolResult.toolGroups: Record<string, NormalizedToolDef[]>`; `startMinionSession` accepts optional `harness`.
- `server/routines/external-mcp.ts` — Claude SDK-shaped `mcpServers` config.
- `server/multimodal-prompt.ts` — `buildQueryPrompt` returns Claude SDK `SDKUserMessage` for image attachments.
- `shared/normalized-event.ts` — already shared by server and client.
- `src/use-socket.ts` — client-side `sync_response` and `session_list` types include `harness` + `harnessCapabilities`.
- `src/components/SessionToolbar.tsx`, `src/model-meta.ts` — Anthropic-flavoured model + thinking UI remains Phase E work.

### Codex SDK facts (verified against `openai/codex@main` `sdk/typescript/src/`)

- `Codex` constructor takes `{ apiKey?, baseUrl?, codexPathOverride?, config?, env? }`.
  `config` is a free-form `CodexConfigObject` that the SDK flattens to `--config key=value` overrides on the CLI — this is the mechanism for injecting per-session MCP servers without touching `~/.codex/config.toml`.
- `codex.startThread(opts)` and `codex.resumeThread(id, opts)` both return a `Thread`.
- `ThreadOptions`:
  `model`, `sandboxMode` (`"read-only" | "workspace-write" | "danger-full-access"`),
  `workingDirectory`, `skipGitRepoCheck`, `modelReasoningEffort`
  (`"minimal" | "low" | "medium" | "high" | "xhigh"`), `networkAccessEnabled`,
  `webSearchMode` (`"disabled" | "cached" | "live"`), `webSearchEnabled`,
  `approvalPolicy` (`"never" | "on-request" | "on-failure" | "untrusted"`),
  `additionalDirectories`.
- `thread.runStreamed(input, { signal? }) → { events: AsyncGenerator<ThreadEvent> }`.
- `Input = string | UserInput[]` where `UserInput = { type: "text", text } | { type: "local_image", path }`. There is **no base64 image input** — Codex always reads images from local files.
- `ThreadEvent`: `thread.started` | `turn.started` | `turn.completed` | `turn.failed` | `item.started` | `item.updated` | `item.completed` | `error`.
- `ThreadItem`: `agent_message` | `reasoning` | `command_execution` | `file_change` | `mcp_tool_call` | `web_search` | `todo_list` | `error`.
- `Usage`: `{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }`.
- Codex MCP transports: **stdio** and **streamable HTTP only** (no SSE). HTTP fields: `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, plus universal `enabled`, `enabled_tools`, `disabled_tools`, `startup_timeout_sec`, `tool_timeout_sec`. Stdio fields: `command`, `args`, `env`, `env_vars`, `cwd`. Sources: `developers.openai.com/codex/sdk`, `developers.openai.com/codex/mcp`.

## Current Branch Readiness

### Complete in Phase A

- `AgentHarness.start()` returns `{ events, control }` atomically.
- `HarnessRunControl` owns live-run commands; every optional method has the
  unsupported-by-harness fallback.
- `HarnessStaticInfo` owns run-independent info (`models`, `commands`, `agents`,
  `account`) so those commands work without an active query.
- `SessionHost.queryHandle` is gone; `eventStream` and `runControl` are assigned
  and cleared together.
- Claude and Echo implement the new contract.
- Server typecheck is clean and included in `pnpm verify`.

### Complete in Phase B

- `server/commands/types.ts` has `WsCommand.harness?: string`.
- `create_session` validates `cmd.harness` against `registeredHarnessNames()` and
  emits a session-scoped `session_error` for unknown harnesses.
- `send_message` pins the existing host harness; no mid-thread harness swap in MVP.
- `startMinionSession` accepts optional `harness` and defaults to the leader's
  `harnessName`.
- SQLite persistence stores `sessions.harness_name`; legacy rows default to
  `"claude"`; hydration restores the persisted harness.
- `sync_session` and `session_list` expose `harness` and `harnessCapabilities`
  with `null` capabilities for unregistered harness names.
- `src/use-socket.ts` mirrors those server-to-client payload fields.

### Still not ready for Codex

- **No MCP bridge yet.** `server/mcp-bridge/` does not exist; Phase C must create
  the streamable HTTP bridge and config renderer before Codex can call Minions
  tools.
- **No Codex harness yet.** `server/harness/codex/` and `@openai/codex-sdk` are
  Phase D.
- **Image attachments are still Claude-shaped.** `server/multimodal-prompt.ts`
  returns a Claude SDK `SDKUserMessage`; Phase D must move prompt/input
  formatting into harness-specific code and add normalized `attachments` to
  `HarnessStartOptions`.
- **External MCP config is still Claude-shaped.** `server/routines/external-mcp.ts`
  emits Claude SDK config objects; Phase C/D must introduce a normalized source
  shape plus per-harness renderers.
- **Codex permission mapping is not wired.** `HarnessStartOptions` has
  `sessionKey` already; Phase D still needs `permissionMode` so Codex can map it
  to `approvalPolicy` and `sandboxMode`.
- **UI selection is still Phase E.** The data needed by the UI is now in sync
  payloads, but `SessionToolbar` and `model-meta.ts` remain Claude-oriented.

### Validation run

```bash
pnpm typecheck         # PASS
pnpm typecheck:server  # PASS
pnpm verify            # PASS as of Phase B follow-up
```

## Recommended Architecture

### 1. Events and runtime control

Current contract: `SessionHost` stores the event stream separately from the
provider-neutral live-run control surface.

```ts
// server/session-host.ts
eventStream: AsyncIterable<NormalizedEvent> | null;
runControl: HarnessRunControl | null;
```

The provider-neutral control interface in `server/harness/types.ts` is:

```ts
export interface HarnessRunControl {
  /** Idempotent. */
  abort(): void;
  close?(): Promise<void>;
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  getContextUsage?(): Promise<unknown>;
  mcpServerStatus?(): Promise<unknown>;
  rewindFiles?(args: { userMessageId: string; dryRun?: boolean }): Promise<unknown>;
  seedReadState?(args: { path: string; mtime: number }): Promise<unknown>;
  stopTask?(taskId: string): Promise<unknown>;
  reconnectMcpServer?(serverName: string): Promise<unknown>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<unknown>;
}
```

`start()` returns `{ events, control }`.

```ts
// server/harness/types.ts
start(opts: HarnessStartOptions): {
  events: AsyncIterable<NormalizedEvent>;
  control: HarnessRunControl;
};
```

This was chosen over a `currentControl()` getter because returning the pair
atomically lets `SessionHost.start()` assign both fields in one statement and
clear both in the same `finally` path. Callers never observe a previous run's
controller or a half-started current run.

`SessionHost.start()` becomes:

```ts
const { events, control } = harness.start(startOpts);
this.eventStream = events;
this.runControl = control;
try {
  for await (const event of events) { ... }
} finally {
  this.eventStream = null;
  this.runControl = null;
}
```

### 2. Per-command "unsupported" semantics

Every live-run command follows this shape:

```ts
const fn = host.runControl?.fn;
if (!fn) {
  unsupportedByHarness(ws, command, host, requestId);
  return;
}
fn(args).then(...).catch(...);
```

The error wording is part of the contract. Clients distinguish `"No active query"`
from "the active harness lacks this capability". The shared helper in
`server/commands/helpers.ts` emits:

```ts
export function unsupportedByHarness(
  ws, command, host, requestId,
): void {
  sendControlError(ws, command, host.id, requestId,
    `"${command}" is not supported by harness "${host.harnessName}".`);
}
```

Per-command MVP behaviour by harness:

| Command | Claude | Codex (MVP) | Echo |
|---|---|---|---|
| `interrupt` / `interrupt_session` | `runControl.interrupt()` | `runControl.abort()` only (cancels the AbortSignal passed to `runStreamed`); no auto-restart | unsupported |
| `set_model` | `runControl.setModel()` | unsupported (model fixed at thread start; restart with new model) | unsupported |
| `set_permission_mode` | `runControl.setPermissionMode()` | unsupported (gate via `approvalPolicy` at thread start) | unsupported |
| `close_session` | `runControl.close()` | abort signal | abort signal |
| `remove_session` | `runControl.close()` | abort signal | abort signal |
| `stop_task` | `runControl.stopTask()` | unsupported | unsupported |
| `rewind_files` | `runControl.rewindFiles()` | unsupported (deferred) | unsupported |
| `seed_read_state` | `runControl.seedReadState()` | unsupported | unsupported |
| `reconnect_mcp_server` | `runControl.reconnectMcpServer()` | unsupported (handled by bridge restart) | unsupported |
| `toggle_mcp_server` | `runControl.toggleMcpServer()` | unsupported | unsupported |
| `get_context_usage` | `runControl.getContextUsage()` | derive from last `usage` event already buffered on host | unsupported |
| `get_supported_models` | reads `staticInfo().models` (see §5) | reads `staticInfo().models` from `server/harness/codex/models.ts` | reads `staticInfo().models` (single echo entry) |
| `get_supported_commands` | reads `staticInfo().commands` | `[]` | `[]` |
| `get_supported_agents` | reads `staticInfo().agents` | `[]` | `[]` |
| `get_account_info` | reads `staticInfo().account` | `{ provider: "openai" }` | `{ provider: "echo" }` |
| `get_mcp_server_status` | `runControl.mcpServerStatus()` | bridge-derived: list configured servers + enabled flag | unsupported |

`get_supported_models`, `get_supported_commands`, `get_supported_agents`,
`get_account_info` already use harness-static methods (see §5) so they work even
when no run is live.

### 3. `harness` flow

| Surface | Change |
|---|---|
| `WsCommand` (`server/commands/types.ts`) | Done: `harness?: string`. |
| `create_session` | Done: forwards `cmd.harness` into `registry.start({ ..., harness: cmd.harness })`. Rejects upfront if the name is not registered and emits `session_error`. |
| `send_message` | Done: does **not** accept `harness` mid-thread; the host's existing `harnessName` wins. (Harness swap mid-session is deferred — see Open Questions §1.) |
| `SessionHost.start` | Done: honours `opts.harness`; defaults to Claude. |
| `AgentTypeContext.startMinionSession` | Done: accepts `harness?: string`; defaults to the leader's `harnessName` so a Codex leader will spawn Codex minions. |
| `wait_and_continue` resume in `SessionHost.buildAgentContext` | Already passes `harness: this.harnessName`; keep. |
| WS contract tests | Deferred unless a dispatcher-level contract rig is added; per-handler tests currently pin the contract. |

### 4. Persistence

Done: `sessions` has a harness column with a legacy default:

```sql
ALTER TABLE sessions ADD COLUMN harness_name TEXT NOT NULL DEFAULT 'claude';
```

Update:
- `server/session-repo.ts` `SessionRow` includes `harness_name: string`.
- `server/session-repo.ts` `upsertSession` writes it.
- `server/session-persist.ts` `PersistableSession` includes `harnessName: string`.
- `server/session-host.ts` `SessionHost.persist()` includes `harnessName: this.harnessName`.
- `SessionRegistry.hydrateFromDb()` sets `host.harnessName = row.harness_name || "claude"`.

### 5. UI / sync

- Done: `sync_session` emits `harness` and `harnessCapabilities` in the
  `sync_response` payload.
- Done: `session_list` includes the same metadata so the sessions panel can
  render harness-aware affordances without extra per-session sync calls.
- Done: `src/use-socket.ts` mirrors the server-to-client metadata shape.
- Done: `AgentHarness` has a single `staticInfo(): HarnessStaticInfo` method so
  info-queries that don't need a live run return harness-declared values:

  ```ts
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
  ```

  One method beats four because it lets each harness module own its data
  wholesale. `get_supported_models`, `get_supported_commands`,
  `get_supported_agents`, and `get_account_info` read the corresponding field
  from `staticInfo()` instead of routing through `runControl`.
- Phase E: `src/components/SessionToolbar.tsx` reads `harnessCapabilities` to
  decide which controls render. Model dropdown becomes harness-scoped.
- Phase E: `src/model-meta.ts` either
  (a) becomes a per-harness map keyed by harness name, or
  (b) is moved into harness modules and re-exported through a registry call.
  Pick (b) — it puts the metadata next to the harness that owns it and keeps
  `model-meta.ts` from gaining a `claude:`/`codex:` switch.

## Codex Harness

### File layout

```text
server/harness/codex/
  index.ts          # CodexHarness class + registerHarness()
  translate.ts      # ThreadEvent → NormalizedEvent[]
  translate.test.ts
  models.ts         # static model list + alias map + reasoning-effort gating
  options.ts        # mapPermission(), mapReasoningEffort(), mapSandboxMode()
  attachments.ts    # base64 → temp files; lifecycle/cleanup
  attachments.test.ts
  mcp-config.ts     # render Codex --config overrides for the bridge + external MCP
  mcp-config.test.ts
  index.test.ts
```

Plus the bridge it depends on (§Codex MCP Bridge):

```text
server/mcp-bridge/
  server.ts          # singleton streamable-HTTP MCP server (loopback)
  registry.ts        # per-session token + tool group registration
  server.test.ts
  registry.test.ts
```

### Dependency

```bash
pnpm add @openai/codex-sdk
pnpm add @modelcontextprotocol/sdk        # used by the bridge server
```

(`@modelcontextprotocol/sdk` is already a transitive dep of the Claude SDK; pin
it explicitly so the bridge owns its version.)

### Capabilities

```ts
const CODEX_CAPABILITIES: HarnessCapabilities = {
  thinking: true,           // Reasoning items + modelReasoningEffort
  promptCaching: true,      // Usage.cached_input_tokens
  mcp: true,                // Codex MCP via config overrides
  permissionPrompts: true,  // approvalPolicy
  resume: true,             // resumeThread(id)
  partialMessages: false,   // SDK emits item-level updates, not text deltas
  builtInFilesystem: true,  // command_execution / file_change items
};
```

### `start()` sketch

```ts
start(opts: HarnessStartOptions): { events; control } {
  const ac = new AbortController();
  opts.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });

  const bridge = getBridgeServer().register({
    sessionKey: opts.sessionKey,
    groups: this.registeredGroups,
  });
  const codex = new Codex({
    ...(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
      ? { apiKey: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY }
      : {}),
    ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
    config: buildCodexConfig({
      bridge,                                      // Minions-internal MCP
      external: opts.externalMcpServers ?? {},     // already-rendered Codex shape
    }),
  });

  const baseOpts = {
    model: opts.model,
    workingDirectory: opts.cwd,
    sandboxMode: mapSandboxMode(opts /* deferred: per-session override */),
    approvalPolicy: mapPermission(/* read from a HarnessStartOptions.permissionMode */),
    ...(opts.thinking ? { modelReasoningEffort: mapReasoningEffort(opts.thinking.effort) } : {}),
  };
  const thread = opts.resumeId
    ? codex.resumeThread(opts.resumeId, baseOpts)
    : codex.startThread(baseOpts);

  const input = await buildCodexInput(opts);   // string | UserInput[]

  const events = (async function* () {
    let threadId = opts.resumeId ?? "";
    try {
      const { events: stream } = await thread.runStreamed(input, { signal: ac.signal });
      for await (const evt of stream) {
        if (evt.type === "thread.started") threadId = evt.thread_id;
        yield* codexToNormalized(evt, { sessionId: () => threadId, model: opts.model });
      }
      yield { kind: "done", reason: ac.signal.aborted ? "abort" : "stop" };
    } catch (err) {
      yield { kind: "done", reason: "error", error: errorMessage(err) };
    } finally {
      bridge.dispose();
      await disposeAttachmentScratch(opts);
    }
  })();

  const control: HarnessRunControl = {
    abort: () => ac.abort(),
  };
  return { events, control };
}
```

`HarnessStartOptions` already has `sessionKey`. Phase D still needs
`permissionMode` and `attachments` so Codex can map permissions and consume
images without leaking Claude SDK message shapes:

```ts
/**
 * Stable per-session identity. Required by harnesses that need to scope
 * external resources to a session — the MCP bridge route
 * (`/mcp/<sessionKey>/<group>`) and the Codex attachment scratch directory
 * (`<tmpdir>/minions-codex-attachments/<sessionKey>/`) both key off it.
 * Populated from `SessionHost.id` in `buildHarnessStartOpts`.
 */
sessionKey: string;
permissionMode?: "default" | "auto" | "bypassPermissions" | "plan";
attachments?: ReadonlyArray<{
  kind: "image";
  filename?: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;          // base64, no data: prefix
}>;
```

`buildHarnessStartOpts` already populates `sessionKey` from `SessionHost.id`.
Phase D should also populate `permissionMode` and normalized `attachments` from
`StartSessionOptions`. The Claude adapter keeps building its `SDKUserMessage`
from `attachments`; the Codex adapter uses `sessionKey` for the bridge route and
attachment temp path, then returns `UserInput[]` with `local_image` entries.
This eliminates `buildQueryPrompt`'s leak of `SDKUserMessage` into shared code.

### Event translation

| Codex event/item | NormalizedEvent |
|---|---|
| `thread.started { thread_id }` | `{ kind: "init", sessionId: thread_id, model: opts.model }` |
| `turn.started` | _(swallowed; no NormalizedEvent variant; informational only)_ |
| `item.started` `mcp_tool_call` | `{ kind: "tool_call", id, name: \`mcp__${server}__${tool}\`, input: arguments }` |
| `item.updated` `mcp_tool_call` | `{ kind: "tool_progress", id, name, elapsedSeconds }` |
| `item.completed` `mcp_tool_call` (success) | `{ kind: "tool_result", callId: id, output: result, isError: false }` |
| `item.completed` `mcp_tool_call` (failed) | `{ kind: "tool_result", callId: id, output: error.message, isError: true }` |
| `item.started/updated/completed` `command_execution` | `tool_call` / `tool_progress` / `tool_result` with `name: "codex_command"`; output carries `command`, `aggregated_output`, `exit_code` |
| `item.completed` `file_change` | `tool_result` with `name: "codex_file_change"`, output `{ changes, status }` |
| `item.completed` `web_search` | `tool_result` with `name: "web_search"`, output `{ query }` |
| `item.completed` `agent_message` | `{ kind: "text", role: "assistant", text }` |
| `item.completed` `reasoning` | `{ kind: "thinking", text }` |
| `item.completed` `todo_list` | _(MVP: swallow; see Open Questions §2)_ |
| `item.completed` `error` (non-fatal) | `{ kind: "permission_denial", tool: "codex", reason: message }` _(closest existing variant; revisit if a new variant is needed)_ |
| `turn.completed { usage }` | `{ kind: "usage", input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cached_input_tokens }` |
| `turn.failed { error }` | `{ kind: "done", reason: "error", error: error.message }` |
| `error { message }` | `{ kind: "done", reason: "error", error: message }` |

`reasoning_output_tokens` is not represented today. **MVP:** drop it.
**Phase E (later hardening):** add `reasoningOutput?: number` to
`shared/normalized-event.ts` `usage` and surface it on the dashboard.

`elapsedSeconds` for `tool_progress` is computed by the translator from a per-id
`startedAt` map seeded on `item.started`.

`done` is emitted exactly once per run — by the harness, after `turn.completed`,
or in the `catch`/`abort` path. The translator must not emit it from
`turn.completed` itself; only the outer generator does.

## Codex MCP Bridge

Codex consumes MCP through config; `createSdkMcpServer` (Claude SDK in-process)
is unreachable from the Codex process. The bridge stands up a real MCP endpoint
over loopback so every harness can be pointed at it.

**Decision: streamable HTTP, not stdio.** Justification:

- Codex MCP confirmed transports are stdio + streamable HTTP. HTTP wins for
  Minions because:
  - One bridge process serves every concurrent session; stdio would spawn one
    subprocess per session per tool group.
  - Per-session bearer tokens give us cheap auth and a clean teardown path
    (delete the token, future requests 401).
  - Loopback (`127.0.0.1:<random-port>`) keeps it off the network.
  - Tool registration is dynamic: the leader's task tools differ from a
    minion's report tools; HTTP routes (`/mcp/<sessionKey>/<group>`) make that
    trivial. With stdio we'd be re-execing per session.
- The Claude adapter keeps its existing `wrapTools()` in-process path for
  latency. Migrating Claude onto the bridge is deferred (Open Questions §4).

### Shape

```ts
// server/mcp-bridge/server.ts
export interface McpBridgeServer {
  url: string;                        // "http://127.0.0.1:<port>"
  register(opts: {
    sessionKey: string;
    groups: Record<string, NormalizedToolDef[]>;
  }): McpBridgeRegistration;
  dispose(): Promise<void>;
}

export interface McpBridgeRegistration {
  /** "http://127.0.0.1:<port>/mcp/<sessionKey>/<groupName>" */
  urlFor(group: string): string;
  bearerToken: string;                // random per session
  dispose(): void;                    // unregister + invalidate token
}
```

The HTTP server is a singleton lazily started by `getBridgeServer()`. Per-session
tokens live in an in-memory `Map<sessionKey, { token, groups }>`. The MCP
endpoint validates `Authorization: Bearer <token>` against the `sessionKey` in
the URL, then dispatches `tools/list` and `tools/call` to the matching
`NormalizedToolDef`.

### Codex `--config` rendering

```ts
// server/harness/codex/mcp-config.ts
function renderBridgeServers(reg: McpBridgeRegistration, groups: string[]) {
  const out: CodexConfigObject = {};
  for (const group of groups) {
    out[`mcp_servers.${group}`] = {
      url: reg.urlFor(group),
      bearer_token_env_var: `MINIONS_BRIDGE_TOKEN_${group}`,
      // SDK injects env via CodexOptions.env; token never sits in argv.
    };
  }
  return out;
}
```

Tokens are passed through `CodexOptions.env`, not via `http_headers` (avoids
leaking them into Codex CLI logs that quote `--config` values).

### External MCP

> **Phase D status: deferred for Codex.** The Phase D Codex harness consumes
> only Minions-internal tool groups (task-manager, render-dashboard,
> minion-status) through the bridge. User-configured external MCP servers
> resolved from the project sidecar's `mcp-servers.json` are still produced in
> Claude SDK shape by `server/routines/external-mcp.ts` and **silently dropped**
> by the Codex harness — passing them through unchanged would either be
> rejected by the Codex CLI or render incorrectly. Codex external MCP does
> not appear in `HarnessCapabilities` and is not advertised in `staticInfo()`.
> The Phase D Codex harness leaves an explicit comment near its `Codex`
> constructor call documenting the drop.

The eventual fix replaces `server/routines/external-mcp.ts` with a normalized
shape and per-harness renderers:

```ts
// server/routines/external-mcp.ts
export interface NormalizedExternalMcp {
  id: string;
  toolNames: string[];                          // already prefixed mcp__id__name
  config:
    | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { transport: "http";  url: string; headers?: Record<string, string> };
  // (SSE dropped — Codex doesn't support it; Claude renderer can still emit
  //  a Claude-shaped sse server if a config marks transport: "sse" later.)
}

// server/harness/claude/external-mcp.ts → SDK mcpServers config
// server/harness/codex/external-mcp.ts  → CodexConfigObject mcp_servers entries
```

`HarnessStartOptions.externalMcpServers` keeps its `Record<string, unknown>`
type (each harness understands its own native shape after rendering); only the
**source** representation becomes harness-neutral. This work is **out of scope
for Phase D** — it lands alongside Phase E UI work, where a "Codex external
MCP unavailable" affordance can also be surfaced to the user.

## Implementation Plan

### Phase A — stabilize the existing seam (complete)

Goal achieved: the second-harness substrate compiles, types, tests, and exposes
a provider-neutral live-run control surface.

Implemented:

1. `HarnessRunControl`, `HarnessStaticInfo`, required `sessionKey`, and
   `{ events, control }` landed in `server/harness/types.ts`.
2. Claude and Echo implement the new contract.
3. `SessionHost.queryHandle` was replaced by `eventStream` + `runControl`.
4. Command handlers return `"No active query"` when no run exists and
   `"<command>" is not supported by harness "<name>".` when the active harness
   lacks a method.
5. Static info commands read `harness.staticInfo()`.
6. Collateral server type errors were fixed.
7. `pnpm typecheck:server` is part of `pnpm verify`.

### Phase B — make harness selection real (complete)

Implemented:

1. `server/commands/types.ts` has `WsCommand.harness?: string`.
2. `server/commands/create-session.ts` forwards and validates `cmd.harness`.
3. `server/commands/send-message.ts` explicitly keeps the host's existing
   harness on resume.
4. `startMinionSession` accepts optional `harness`; leader harness inheritance
   is tested.
5. SQLite stores `harness_name`; persistence and hydration round-trip it.
6. `sync_session` and `session_list` expose `harness` and
   `harnessCapabilities`.
7. `src/use-socket.ts` mirrors the server payload shape.
8. Tests cover create-session selection, invalid harness errors, send-message
   override ignoring, minion inheritance, persistence, sync payloads, and
   session-list metadata.

### Phase C — MCP bridge (next; required for MVP)

1. Add `server/mcp-bridge/server.ts` and `registry.ts`.
2. Implement `tools/list` + `tools/call` over streamable HTTP, dispatching to
   `NormalizedToolDef.handler`; auth via `Authorization: Bearer <token>`.
3. Bridge lifecycle: lazy-start on first registration; `dispose()` on shutdown.
4. Render Codex config overrides in `server/harness/codex/mcp-config.ts`
   (consumed in Phase D).
5. Tests:
    - `server/mcp-bridge/server.test.ts` — list-tools and call-tool against an
      in-process bridge; reject without bearer; reject with another session's
      token.
    - `server/mcp-bridge/registry.test.ts` — register/dispose; double-dispose
      is idempotent.
    - `server/harness/codex/mcp-config.test.ts` — bridge groups + env mapping
      produce a CodexConfigObject with `mcp_servers.task-manager.url`,
      `mcp_servers.task-manager.bearer_token_env_var`.

### Phase D — Codex harness (required for MVP)

1. `pnpm add @openai/codex-sdk @modelcontextprotocol/sdk`.
2. Implement `server/harness/codex/{index,translate,models,options,attachments,mcp-config}.ts`.
3. Register from `server/session-host.ts` (`import "./harness/codex/index.ts";`).
4. Move `buildQueryPrompt` out of shared territory: introduce
   `harness.buildInput(opts)` (or a per-adapter `formatPrompt(opts)`); the
   Claude adapter returns the existing `SDKUserMessage`-or-string, the Codex
   adapter returns `string | UserInput[]`. `buildHarnessStartOpts` stops
   importing `multimodal-prompt.ts` directly.
5. Pass `attachments` and `permissionMode` into `HarnessStartOptions` from
   `StartSessionOptions`.
6. Tests:
    - `server/harness/codex/translate.test.ts` — table-driven over each item
      type and event type; asserts the NormalizedEvent shape matches the
      Phase D mapping table.
    - `server/harness/codex/attachments.test.ts` — base64 → temp file under
      `os.tmpdir()/minions-codex-attachments/<sessionKey>/`, mediaType ext
      preserved, cleanup removes the directory.
    - `server/harness/codex/options.test.ts` — `mapPermission`,
      `mapReasoningEffort`, `mapSandboxMode` tables.
    - `server/harness/codex/index.test.ts` — mocked `Codex` class (via
      `vi.mock("@openai/codex-sdk")`), assert `init`, a couple of items, a
      `usage`, and `done` are emitted in order; assert `abort()` propagates.
    - `tests/contracts/ws-codex-roundtrip.test.ts` — `create_session` with
      `harness: "codex"` produces an `init` event whose `model` matches the
      requested model.

### Phase E — UI + later hardening (not required for MVP)

- Move `src/model-meta.ts` data into per-harness modules; surface via
  `harnessCapabilities` from sync.
- Harness selector in `src/components/SessionToolbar.tsx`; gate
  thinking/permission controls by capability.
- Render Codex `todo_list` items in the plan UI (Open Question §2).
- Add `usage.reasoningOutput` and surface it on the dashboard.
- Mid-session harness swap.
- Migrate Claude onto the bridge for parity (latency permitting).
- README/preflight: install `codex` CLI, `OPENAI_API_KEY`/`CODEX_API_KEY`,
  optional `CODEX_PATH`.

## Acceptance Criteria

Already satisfied by Phases A/B:

- `pnpm verify` runs `pnpm typecheck:server` and the whole verify chain passes.
- `create_session` with `harness: "echo"` reaches the host through the same
  command path the UI uses.
- Session persistence stores `harness_name` and hydration restores it, with
  legacy rows defaulting to `"claude"`.
- A leader spawning a minion passes its harness by default, with explicit
  override support.
- `sync_session` and `session_list` expose `harness` and `harnessCapabilities`.
- Every current command in the §2 table either succeeds, returns `"No active
  query"`, or returns `"<command>" is not supported by harness "<name>".`

Remaining MVP acceptance after Phases C/D:

- `create_session` with `harness: "codex"` emits `init` (with `sessionId =
  thread_id`), at least one visible `text` event, a `usage`, and exactly one
  `done`.
- A Codex leader can call `plan_task`, `assign_task`, `render_set`, and
  `request_approval` through the MCP bridge. Tool calls land in the same
  reducers as Claude calls.
- A Codex leader spawning a minion produces a Codex minion (not Claude).
- `resume` via `send_message` reuses the persisted Codex `thread_id`.
- Codex unsupported commands return `"<command>" is not supported by harness
  "<name>".` rather than throwing or silently no-oping.
- Claude's existing test suite passes unchanged.

Explicitly **not** required for MVP (Phase E):
- Mid-session harness swap.
- Per-harness model dropdown / capability-gated UI.
- `todo_list` rendering in the plan UI.
- `usage.reasoningOutput` field.
- Migration of Claude onto the bridge.

## Open Questions

1. **Mid-session harness swap.** Deferred. MVP fixes the harness at
   `create_session`; `send_message` ignores `cmd.harness`. Adding a
   "switch model from Claude → Codex on the next turn" affordance later is
   purely additive — it just calls `start` with a different harness name and
   no resume id.
2. **Codex `todo_list` items vs. our `plan_task` MCP tool.** Two plans on
   screen confuses users. MVP swallows `todo_list`; the leader uses
   `plan_task` like Claude does. Phase E may render Codex's native todo list
   in the plan UI for non-leader Codex sessions only.
3. **`reasoning_output_tokens`.** Not in `usage` today. MVP drops it.
   Phase E adds `reasoningOutput?: number` and updates the usage widget.
4. **Claude-on-bridge migration.** Both paths work; latency prefers
   in-process. Defer until either we hit an MCP server type that's painful
   to wire twice or we want to break the Claude SDK dep boundary further.
5. **Permission-mode mapping.** First mapping (Codex `approvalPolicy`):

   | Minions `permissionMode` | Codex `approvalPolicy` | Codex `sandboxMode` |
   |---|---|---|
   | `bypassPermissions` | `never` | `workspace-write` |
   | `auto` (default) | `on-failure` | `workspace-write` |
   | `default` | `on-request` | `workspace-write` |
   | `plan` | unsupported (UI disables for Codex in Phase E) | n/a |
