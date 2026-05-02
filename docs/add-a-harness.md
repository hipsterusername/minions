# Adding a New Harness

This guide covers everything you need to add a second LLM backend to
Minions. It documents the actual current codebase — not the migration
spec that describes what was built. Read `docs/model-agnosticism-spec.md`
if you want the why behind the design.

**What a harness is.** A harness is a class that runs one agent session
against a specific LLM backend and emits a stream of normalized events.
It owns nothing about the canvas, the bus, persistence, the worktree,
or the UI. It owns: model selection, the chat/query loop, tool
registration, abort, and resume.

---

## Module layout

```
server/harness/
  index.ts          — registry (registerHarness, getHarness)
  types.ts          — AgentHarness interface + all supporting types
  claude/           — reference implementation (Claude Code SDK)
    index.ts
    translate.ts
    tools.ts
    models.ts
  echo/             — minimal second harness (test fixture)
    index.ts
  <your-harness>/   — one directory per harness, self-contained
    index.ts        — required entry point
    translate.ts    — optional: SDK message → NormalizedEvent (if needed)
    models.ts       — optional: model alias map
```

The architecture test at
`tests/architecture/no-claude-sdk-outside-harness.test.ts` enforces that
`@anthropic-ai/claude-agent-sdk` is only imported within
`server/harness/claude/`. Your harness files must not import it.

---

## Step 1 — Create `server/harness/<name>/index.ts`

Implement the `AgentHarness` interface from `server/harness/types.ts`.
The complete interface is:

```ts
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessStartOptions,
  NormalizedToolDef,
  NormalizedUserMessage,
} from "../types.ts";
import type { NormalizedEvent } from "../../../shared/normalized-event.ts";
import { registerHarness } from "../index.ts";

const MY_CAPABILITIES: HarnessCapabilities = {
  thinking: false,          // extended / adaptive thinking blocks
  promptCaching: false,     // cache_read / cache_creation token accounting
  mcp: false,               // native MCP protocol; set false for function-calling shims
  permissionPrompts: false, // can defer tool calls to a human approval queue
  resume: false,            // can resume a prior session by ID
  partialMessages: false,   // emits text_delta streaming chunks
  builtInFilesystem: false, // ships built-in file tools (Read, Write, Bash, etc.)
};

class MyHarness implements AgentHarness {
  readonly name = "my-harness";         // unique, stable key used in StartSessionOptions
  readonly capabilities = MY_CAPABILITIES;
  readonly builtInTools: string[] = []; // names the harness exposes without MCP (e.g. ["Read"])

  private registeredGroups: Record<string, NormalizedToolDef[]> = {};
  private abortController: AbortController | null = null;

  // Called before start(). Keys become MCP server names so tool calls
  // follow the mcp__<serverName>__<toolName> pattern.
  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void {
    this.registeredGroups = toolGroups;
  }

  // Map a user alias ("opus", "sonnet") to a concrete model ID.
  // Return null for an empty/null input; return the string unchanged if unknown.
  resolveModel(alias: string): string | null {
    return alias || null;
  }

  // Abort a running session. Idempotent — safe to call multiple times.
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  // Run the session. MUST emit `init` first and `done` last.
  // MUST catch internal errors and emit done({ reason: "error" }) rather
  // than throwing — the caller's for-await loop does not expect throws.
  async *start(opts: HarnessStartOptions): AsyncIterable<NormalizedEvent> {
    const ac = new AbortController();
    this.abortController = ac;
    opts.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });

    yield { kind: "init", sessionId: `${this.name}-${Date.now()}`, model: opts.model };

    try {
      // ... run your LLM loop, yielding NormalizedEvents ...
      yield { kind: "text", text: "hello", role: "assistant" };
      yield { kind: "done", reason: "completed" };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      yield { kind: "done", reason: "error", error };
    }
  }
}

export const myHarness = new MyHarness();
registerHarness(myHarness);
```

See `server/harness/echo/index.ts` for a complete minimal example.
See `server/harness/claude/index.ts` for the production reference.

---

## Step 2 — Register it in session-host.ts

Add a single side-effect import to `server/session-host.ts` alongside the
existing Claude registration line:

```ts
import "./harness/claude/index.ts"; // registers ClaudeHarness
import "./harness/my-harness/index.ts"; // registers MyHarness
```

That's all. The harness is now live and reachable via `getHarness("my-harness")`.

---

## Step 3 — Use it in a session

Pass `harness: "my-harness"` in `StartSessionOptions` when starting a
session. The WS command handler or `server/index.ts` passes this through
to `host.start(opts, deps)` which resolves `getHarness(opts.harness ?? "claude")`.

```ts
deps.startChildSession({
  sessionKey: "...",
  prompt: "...",
  cwd: "/path/to/project",
  harness: "my-harness",   // ← selects your harness
});
```

The harness name is stored on `SessionHost.harnessName` and threaded
through `wait_and_continue` resumes so the same harness is used for the
resumed session.

---

## The `HarnessCapabilities` flags in detail

| Flag | What it gates |
|---|---|
| `thinking` | `HarnessStartOptions.thinking` is passed to `start()` only when this is `true`. The session-host checks `harness.capabilities.thinking && host.thinkingConfig?.enabled && modelSupportsAdaptive(host.model)` before setting `startOpts.thinking`. |
| `promptCaching` | Informational for now. The `usage` event's `cacheRead` / `cacheCreation` fields are always optional; set them to non-zero only if your backend reports them. |
| `mcp` | Whether your harness speaks the MCP protocol natively (vs. a function-calling shim). Informational — does not gate any host behavior today. |
| `permissionPrompts` | Whether the harness can defer tool calls to a human approval queue. Informational — the UI may use this to decide whether to render an approval UI. |
| `resume` | Whether `HarnessStartOptions.resumeId` is meaningful for your harness. Informational. The host always passes `resumeId` when set; non-resume harnesses ignore it. |
| `partialMessages` | Whether your harness emits `text_delta` streaming chunks. Informational — the client renders streaming text only when it receives `text_delta` events; complete `text` events are always rendered. |
| `builtInFilesystem` | Whether the harness ships built-in file tools (Read, Write, Bash, etc.) via its own binary. `false` means the session relies purely on MCP tools. Replaces the old `harness.name === "claude"` check. |

---

## The `HarnessStartOptions` contract

```ts
// NormalizedUserMessage is defined in server/harness/types.ts:
//   interface NormalizedUserMessage { role: "user"; content: string; }

export interface HarnessStartOptions {
  cwd: string;                                      // working directory
  prompt: string | AsyncIterable<NormalizedUserMessage>; // first user turn
  systemPrompt: string;                             // already built by agent type
  model: string;                                    // already resolved by resolveModel()
  allowedTools: string[];                           // harness.builtInTools + mcp tool names
  abortSignal: AbortSignal;                         // wire into your abort path
  resumeId?: string;                                // opaque per-harness string; ignore if !capabilities.resume
  externalMcpServers?: Record<string, unknown>;     // pre-wrapped MCP server objects (Claude-specific; ignore)
  thinking?: { effort: "low" | "medium" | "high"; display: "summarized" | "omitted" };
}
```

`thinking` is only set when `capabilities.thinking` is true and the
session's `thinkingConfig.enabled` is true and the model is on the
adaptive-thinking allowlist (`modelSupportsAdaptive` in
`server/session-host-config.ts`). Your harness receives it only if all
three conditions are met.

`externalMcpServers` carries pre-wrapped Claude SDK MCP server objects
from a project's `mcp-servers.json`. If your harness is not MCP-native
you can ignore it.

---

## The `NormalizedEvent` contract

Every event kind your harness may emit. You **must** emit `init` first
and `done` last. Everything else is optional — emit only what your
backend produces.

| Kind | Required | Notes |
|---|---|---|
| `init` | **Yes** | First event. `sessionId` is your opaque session ID (can be any unique string). `model` is the resolved model name. `meta` is optional harness-specific data ignored by the host. |
| `done` | **Yes** | Last event. `reason` is `"completed"` on success, `"abort"` on abort, `"error"` on failure. Set `error` on `"error"`. Set `turns` and `costUSD` when available. |
| `text` | No | Complete assistant text block. |
| `text_delta` | No | Streaming text chunk. `blockIndex` identifies the active block. Pair with `stream_end`. |
| `stream_end` | No | Clears the streaming buffer in the UI. Emit after the last `text_delta`. |
| `thinking` | No | Extended thinking / chain-of-thought text. Only emit if `capabilities.thinking`. |
| `tool_call` | No | Assistant requesting a tool. The harness dispatches the call; Minions tools are in `registeredGroups`. |
| `tool_result` | No | Response to a tool call. `isError: true` signals a failed call. |
| `tool_progress` | No | Periodic update while a tool runs. `elapsedSeconds` is wall-clock time since start. |
| `usage` | No | Token and cost accounting. All fields except `input`/`output` are optional. |
| `permission_denial` | No | Tool call blocked by a permission gate. Only emit if `capabilities.permissionPrompts`. |
| `rate_limit` | No | Back-off signal. `retryAfterMs` tells the UI how long to wait. |
| `api_retry` | No | Transient error the harness is retrying. `attempt` starts at 1. |
| `agent_spawned` | No | A sub-agent task has started (Claude Agent-tool specific). |
| `agent_task_update` | No | Sub-agent task status update (Claude Agent-tool specific). |

### `done` reasons

| Reason | When |
|---|---|
| `"completed"` | Normal termination — the LLM returned a final result. |
| `"stop"` | The LLM hit its natural stop condition but without a structured result. |
| `"abort"` | `abort()` was called internally. See note below. |
| `"error"` | An exception escaped your session loop. Always set `error`. |

**Note on `done(abort)` and external abort signals.** When
`opts.abortSignal.aborted` becomes true (externally triggered abort),
the session-host's `for await` loop breaks *before* processing the next
event. This means a `done({ reason: "abort" })` emitted in response to
`opts.abortSignal` will be silently dropped — the host loop has already
exited. The session status stays `"running"` until the next `start()`.
This is the intended behavior. Emit `done({ reason: "abort" })` only
when your *own* internal abort flag fired (`this.aborted`), not in
response to `opts.abortSignal`. See `server/harness/echo/index.ts` for
the pattern.

---

## Tool execution inside `start()`

Tools registered via `registerTools(toolGroups)` are the Minions MCP
tools (plan_task, assign_task, render_set, etc.). If your backend
supports native MCP, wrap each group as a named MCP server so tool calls
follow the `mcp__<serverName>__<toolName>` pattern. See
`server/harness/claude/tools.ts` and `ClaudeHarness.start()` for the
pattern.

If your backend uses function calling instead, flatten the groups and
build a local dispatch table:

```ts
const dispatchTable = new Map<string, NormalizedToolDef["handler"]>();
for (const defs of Object.values(this.registeredGroups)) {
  for (const def of defs) {
    dispatchTable.set(def.name, def.handler);
  }
}
// When the LLM calls a function:
const result = await dispatchTable.get(functionName)?.(parsedInput);
```

The `allowedTools` list in `HarnessStartOptions` contains both
`builtInTools` (file tools from the binary) and the MCP tool names
(e.g. `mcp__task-manager__plan_task`). Pass this list to your backend
so it knows which tools it may call.

---

## Required tests

Per the project working agreement (`CLAUDE.md` and `docs/testing-strategy.md`),
tests ship in the same commit as the harness. Colocate them at
`server/harness/<name>/index.test.ts`. Minimum coverage:

1. **Static properties** — `name`, all seven `capabilities.*` flags
   (thinking, promptCaching, mcp, permissionPrompts, resume,
   partialMessages, builtInFilesystem), `builtInTools`.
2. **Self-registration** — after importing the harness module,
   `registeredHarnessNames()` contains `harness.name`.
3. **`registerTools`** — call it with a correct `Record<string, NormalizedToolDef[]>`
   shape; confirm it stores without throwing:
   ```ts
   harness.registerTools({ "my-server": [def] }); // keyed by server name
   harness.registerTools({});                       // empty map is also valid
   ```
4. **`resolveModel`** — known aliases resolve correctly; empty string returns null.
5. **`start()` event sequence** — collect all yielded events; assert `init`
   first, `done` last, at minimum `[init, done]` for a minimal response.
6. **`start()` with string prompt** — yields expected events.
7. **`start()` with async-iterable prompt** — same.
8. **Abort via `AbortSignal`** — set `abortSignal.aborted` before calling; assert
   `done({ reason: "abort" })` is emitted.
9. **Abort via `harness.abort()`** — call `abort()` while `start()` is suspended;
   assert the session ends with abort.
10. **Error path** — simulate an exception inside the loop; assert
    `done({ reason: "error", error: <message> })` is emitted, not a
    thrown exception.

See `server/harness/echo/index.test.ts` for a complete example test suite.
Note: the echo test omits `builtInFilesystem` from the capabilities check
and passes a flat array to `registerTools` rather than a Record — both are
gaps to avoid in your own tests.

---

## Architecture constraints

1. **Do not import `@anthropic-ai/claude-agent-sdk`** in your harness
   files. The architecture test (`tests/architecture/no-claude-sdk-outside-harness.test.ts`)
   will fail CI.

2. **`builtInTools` must list every tool name your harness exposes by
   default.** The session host builds `allowedTools` from
   `harness.builtInTools + mcp tool names`. A tool missing from this
   list will be blocked.

3. **`start()` must not throw.** Catch all errors internally and emit
   `done({ reason: "error", error })`. Although `SessionHost.start()`
   does wrap the `for await` loop in a try/catch (so an uncaught throw
   won't crash the process), letting an error escape bypasses
   `processNormalizedEvent` — meaning `agentType.onComplete` is never
   called for that session. Always catch and emit `done(error)` to
   guarantee proper cleanup.

4. **Emit `init` before any other event.** The host reads `sessionId`
   and `model` from the first event. If `done` arrives before `init`,
   the session will not have a session ID.

5. **`registerTools` is called before `start()`** in each run. Do not
   rely on data stored from a previous `start()` call. The harness is a
   long-lived singleton; multiple `start()` calls happen over its lifetime.

6. **File size limit: ≤400 lines** per file (`tests/architecture/file-size.test.ts`).
   If your translator is large, split it into `translate.ts` as `ClaudeHarness` does.

---

## Common pitfalls

**Wrong `registerTools` signature.** The method takes
`Record<string, NormalizedToolDef[]>` (a map of server-name → tool defs),
not a flat `NormalizedToolDef[]`. Each key becomes the MCP server name.
Tool call names follow `mcp__<key>__<toolName>`.

**Forgetting `done` on abort.** Your abort check must be after every
`await` point where `abortSignal.aborted` could become true. A missing
`done` leaves the host loop hanging.

**Model not resolved.** `start()` receives the already-resolved model
string (via `resolveModel()`). If `resolveModel` returns null for a
valid alias, the host passes an empty string as `model`. Validate that
your alias map covers all expected inputs.

**Harness not loaded.** `getHarness("my-harness")` throws
`Unknown harness "my-harness"` if the import in `session-host.ts` is
missing. Add the side-effect import in Step 2.

**Re-registering on each `start()`.** The harness is a singleton.
`registerTools` replaces the tool map on each call — that is correct.
But initializing `this.registeredGroups = {}` in `start()` instead of
in `registerTools` will make tools unavailable if `start()` runs before
the next `registerTools` call.
