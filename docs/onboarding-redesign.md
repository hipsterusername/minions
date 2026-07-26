# Public Onboarding and Session Readiness — Implementation Plan

Status: **Implemented in the working tree.** The sections below retain the
design and release checklist used for implementation.

## 1. Outcome and non-negotiable guarantees

A clean clone must support this path:

```text
pnpm install -> pnpm preflight -> pnpm start -> create/open project -> start session
```

The path has these guarantees:

1. Tailscale is optional. The default command is a foreground, loopback-only,
   full-stack process with logs in the terminal.
2. Minions is session-ready when **at least one** production harness is both
   runnable and authenticated. Claude and Codex are independently optional.
3. "Ready" never means "a credential-looking file exists." The exact runtime
   used by the harness must successfully complete its non-interactive auth
   status probe within a timeout.
4. The CLI preflight, project initialization, the harness picker, browser-created
   sessions, and server-spawned Minions consume one readiness contract.
5. Readiness is short-lived and is freshly checked before every new Leader or
   Minion session. A cached green result cannot authorize a later session.
6. New-project defaults are derived from the harnesses that are ready. Static
   cross-provider defaults are not written when one provider is unavailable.
7. Existing project settings are never silently rewritten. A launch may use a
   visible, in-memory fallback, but the requested project/node configuration is
   preserved.
8. The server is authoritative for the effective harness, model, and permission
   mode. The client displays those values; it does not invent them.

"Usable" in this plan means that the configured/bundled harness runtime can be
started and its official local auth-status command reports authenticated. It
cannot promise that a provider will never later have an outage, reject a model,
or enforce a rate limit. Those remain normal session errors.

## 2. Verified current-state gaps

| Gap | Current owner | Consequence |
|---|---|---|
| `pnpm start` configures Tailscale before boot and exits if it fails | `scripts/start.mjs` | No-Tailscale users cannot start the app |
| `pnpm start` detaches and redirects output; `pnpm dev` starts only Vite | `package.json`, `scripts/start.mjs`, `scripts/dev.mjs` | The obvious local commands either hide errors or launch a broken frontend-only app |
| `pnpm preview` is frontend-only | `package.json` | A built preview has no API or WebSocket backend |
| Backend defaults to `0.0.0.0` | `server/index.ts` | The current app is not localhost-only even though Vite is |
| Preflight checks Claude path presence but not Claude auth or Codex | `scripts/preflight.mjs` | A green preflight does not predict session launch |
| Preflight uses shell-string `execSync` | `scripts/preflight.mjs` | Quoting, PATH, and restricted-shell behavior can produce false failures |
| New sidecars always persist Codex Leader + Claude Minions | `server/project-store.ts` | A one-provider user starts with an unusable half-configuration |
| Model compatibility is inferred from `gpt-`/`claude-` prefixes | `server/project-store.ts` | Defaults and fallbacks are disconnected from harness registries |
| Harness inventory is static metadata only | `server/commands/list-harnesses.ts` | The picker cannot distinguish registered from ready |
| `create_session` validates registration, not readiness | `server/commands/create-session.ts` | Auth failures occur after a session has been accepted |
| Server-created Minions omit `permissionMode` | `server/task-tools/assign-task.ts`, `server/session-host-run.ts` | Runtime uses no authoritative project permission seed |
| Canvas labels every spawned Minion `bypassPermissions` | `src/Canvas.tsx` | UI can claim a more permissive mode than the server actually uses |
| README requires Tailscale and describes static mixed-provider defaults | `README.md` | Public onboarding documents the failure path |

The Claude SDK uses its own bundled native executable when
`CLAUDE_CODE_PATH` is unset, and the Codex SDK likewise owns runtime discovery.
Probing a random global `claude` or `codex` executable would therefore be a
different test from the runtime a session uses.

## 3. Target command surface

> **Superseded (2026-07):** `pnpm start` is now the non-blocking **background**
> launcher (`scripts/start.mjs`), and the foreground streaming supervisor moved
> to `pnpm dev` (`scripts/run.mjs`); the `pnpm serve` alias was removed. The
> table below records the original proposal for context. See `README.md` →
> *Scripts* and `tests/architecture/package-scripts.test.ts` for current behavior.

| Command | Required behavior |
|---|---|
| `pnpm preflight` | Run host checks and the shared harness-readiness service. Exit 0 when host blockers pass and at least one harness is ready. Print remediation for every non-ready harness. |
| `pnpm start` | Foreground full-stack development server on loopback. Stream both processes, open the browser, and stop both on `Ctrl-C`. Never invoke Tailscale. |
| `pnpm dev` | Exact alias of `pnpm start`; it must not remain frontend-only. |
| `pnpm build` | Build the frontend as today. |
| `pnpm preview` | Foreground **full-stack** built preview: backend plus `vite preview`, both on loopback. Fail clearly if `dist/` is absent. |
| `pnpm serve` | Explicit background-service mode, loopback by default, with PID/log/status/stop semantics. |
| `pnpm serve -- --tailscale` | Background service plus tailnet HTTPS. This is the only high-level command that configures Tailscale. |
| `pnpm stop/status/restart` | Compatibility aliases for background-service control only. They do not affect a foreground `start` process. |

Implementation shape:

- Add one foreground supervisor (`scripts/run.mjs`) with `dev` and `preview`
  modes. It resolves repository-local `tsx` and Vite binaries and never uses
  `npx`.
- Refocus `scripts/start.mjs` as the background-service controller, or rename it
  to `scripts/serve.mjs` and leave package-script compatibility aliases.
- The supervisor sets `HOST=127.0.0.1` unless the user explicitly supplied
  `HOST`; `server/index.ts` also changes its standalone default to
  `127.0.0.1`. Remote binding therefore requires an explicit configuration.
- Tailscale setup happens after the local processes are healthy. If the
  opt-in Tailscale step fails, report the failure and stop the service started
  by that command; never alter the default local workflow.

## 4. One harness-readiness contract

### 4.1 Wire-safe result schema

Add the Node-only contract under `server/harness/readiness-types.ts` and mirror
only this redacted shape to the client. `schemaVersion` allows additive changes
without guessing at payload shape.

```ts
type HarnessReadinessState =
  | "ready"
  | "runtime_missing"
  | "unauthenticated"
  | "probe_timeout"
  | "probe_failed";

type HarnessAuthSource =
  | "api_key"
  | "oauth"
  | "cli_login"
  | "unknown";

interface HarnessReadiness {
  name: string;
  ready: boolean;
  state: HarnessReadinessState;
  runtime: {
    available: boolean;
    source: "env_override" | "sdk_bundled";
    version?: string;
  };
  auth: {
    authenticated: boolean;
    source: HarnessAuthSource;
  };
  checkedAt: string;
  expiresAt: string;
  durationMs: number;
  remediation?: {
    label: string;
    command?: string;
  };
}

interface HarnessReadinessSnapshot {
  schemaVersion: 1;
  checkedAt: string;
  expiresAt: string;
  ready: boolean;
  readyHarnesses: string[];
  harnesses: HarnessReadiness[];
}
```

Rules:

- `ready === true` only when `runtime.available` and `auth.authenticated` are
  both true and the probe completed normally.
- `readyHarnesses` is stable registry order with internal/test harnesses such
  as `echo` removed.
- Probe stdout/stderr, executable paths, home paths, emails, account IDs,
  tokens, and credential-file contents never enter this schema, logs, or error
  envelopes.
- Remediation is a controlled mapping from state to product-authored text, not
  raw CLI output. Examples are `claude auth login` and `codex login`.
- Individual probes time out after 5 seconds and run concurrently. A timeout is
  non-ready, not an unbounded startup delay.
- Snapshots cache for 30 seconds for display only. `fresh: true` bypasses the
  cache. Concurrent fresh callers share one in-flight probe rather than spawn
  duplicate processes.
- The service is memory-only. Auth state is not persisted to a project, DB, or
  browser storage.

### 4.2 Harness-owned probes using the session runtime

Extend `AgentHarness` with a run-independent `checkReadiness(context)` method
and an `exposure: "production" | "test"` discriminator. The shared service in
`server/harness/readiness.ts` handles concurrency, timeouts, caching, redaction,
and aggregation; each harness only resolves and probes its own runtime. The
registry exposes `productionHarnesses()` so readiness and `list_harnesses` no
longer maintain separate hidden-name lists for `echo`.

Add `server/harness/register-production.ts` as the single side-effect bootstrap
for Claude and Codex. Replace the direct Claude/Codex imports in
`session-host.ts` with this bootstrap import, and have preflight import it too.
This makes a standalone preflight see the same registry as the running server.

Claude:

1. Extract executable resolution from `server/harness/claude/index.ts` into
   `server/harness/claude/runtime.ts`.
2. Resolve `CLAUDE_CODE_PATH` when explicitly set; otherwise resolve the native
   executable shipped with the installed Claude Agent SDK.
3. Pass that resolved path explicitly to `query()` and use the same path for
   `auth status --json`.
4. Accept readiness only when the command exits 0 and its parsed result says
   logged in. Empty, malformed, or interactive output is `probe_failed`.

Codex:

1. Extract SDK/binary resolution and credential environment construction into
   `server/harness/codex/runtime.ts`; keep `CODEX_PATH` as the explicit override.
2. Pass the same resolved binary/environment to the Codex SDK and to
   `codex login status`.
3. Accept readiness only on the official status command's successful exit.
   Do not infer auth from `~/.codex/auth.json` existence. API-key source may be
   reported only as the enum `api_key`; key values are never retained.
4. Replace `missingCodexAuth()` file-existence logic with this probe at launch.

Use `execFile`/`spawn` argument arrays with `shell: false`, a scrubbed capture
buffer, and an `AbortSignal` timeout. Tests inject a process runner and fake
runtime resolver; they never read the developer's real home or contact a
provider.

### 4.3 Consumers

The following all call `getHarnessReadiness()`:

- `scripts/preflight.mjs` with `fresh: true`;
- server startup to warm the display cache without blocking app boot;
- authenticated `GET /api/readiness`, used by the project chooser before a
  project-scoped WebSocket exists; `?refresh=1` requests a fresh probe;
- `list_harnesses`, which adds each harness's current redacted `readiness`;
- new-sidecar initialization with `fresh: true`;
- the session-launch coordinator with `fresh: true` for every Leader and
  Minion launch.

Because probes are asynchronous, command dispatch must safely support
`Promise<void>` handlers and route rejected promises through the existing
redacted error path. Do not block the Node event loop with `spawnSync` in the
server.

## 5. Readiness-derived defaults and model policy

### 5.1 New-project default matrix

`resolveNewProjectDefaults(snapshot)` is a pure function. It is called only
after a fresh snapshot and writes explicit settings when a sidecar is first
created.

| Fresh readiness | Leader | Standard Minion | Mechanical Minion | Reasoning Minion |
|---|---|---|---|---|
| Claude + Codex | Codex / `gpt-5.6-sol` | Claude / `claude-sonnet-5` | Claude / `claude-haiku-4-5` | Claude / `claude-opus-4-8` |
| Codex only | Codex / `gpt-5.6-sol` | Codex / `gpt-5.6-terra` | Codex / `gpt-5.6-luna` | Codex / `gpt-5.6-sol` |
| Claude only | Claude / `claude-opus-4-8` | Claude / `claude-sonnet-5` | Claude / `claude-haiku-4-5` | Claude / `claude-opus-4-8` |
| Neither | No defaults are written; initialization returns `HARNESS_NOT_READY` with the redacted snapshot and remediation |

`defaultModel` remains a legacy mirror of `defaultMinionModel` in newly written
settings until all readers stop consuming it. It is not an independent default.

Project behavior:

- `POST /api/projects` checks readiness before creating the directory,
  sidecar, or recent-project entry.
- `POST /api/projects/open` and `GET /api/projects/:id` check readiness only if
  they would initialize a missing sidecar. Already initialized projects may be
  opened and edited with zero ready harnesses; only new sessions are blocked.
- `initSidecar` receives resolved initial settings. It must no longer choose a
  harness or model internally.
- A blocked HTTP initialization returns status 409 with `{ code:
  "HARNESS_NOT_READY", readiness }`; the client does not parse error prose.
- If readiness changes after project creation, stored settings remain as the
  user's explicit preference. Runtime resolution handles temporary loss.

### 5.2 Ordered model fallback tables

Move model policy beside the harness registries. Do not maintain model IDs in
`project-store.ts`, `SettingsMenu.tsx`, and the harness independently.

```ts
interface HarnessModelPolicy {
  leader: readonly string[];
  minion: {
    mechanical: readonly string[];
    standard: readonly string[];
    reasoning: readonly string[];
  };
}
```

| Harness | Leader chain | Mechanical chain | Standard chain | Reasoning chain |
|---|---|---|---|---|
| Codex | Sol -> Terra -> Luna | Luna -> Terra -> Sol | Terra -> Luna -> Sol | Sol -> Terra -> Luna |
| Claude | Opus 4.8 -> Fable 5 -> Sonnet 5 -> Opus 4.7 -> Haiku | Haiku -> Sonnet 5 -> Fable 5 -> Opus 4.8 -> Opus 4.7 | Sonnet 5 -> Fable 5 -> Haiku -> Opus 4.8 -> Opus 4.7 | Opus 4.8 -> Fable 5 -> Sonnet 5 -> Opus 4.7 -> Haiku |

The table stores canonical IDs from `staticInfo().models`; the friendly names
above are documentation only. A registry test fails if a chain contains an ID
that the harness does not advertise, repeats an ID, or omits an advertised
fallback without an explicit test waiver.

Resolution rules, in order:

1. Keep the requested harness when it is ready.
2. If it is not ready, choose another ready production harness in stable
   registry order and record `harness_not_ready`.
3. On the effective harness, keep an explicit model when it is a known alias,
   advertised model, or provider-compatible custom ID. A model recognized by a
   different registered harness is incompatible; an ID recognized by none is
   treated as a custom ID compatible with its explicitly requested harness.
4. Never carry a model across a harness switch. For an incompatible model,
   select the first registered ID in the effective harness's chain for the
   role/executor class and record `model_incompatible`.
5. If a persisted model is merely unknown but provider-compatible, preserve it
   and let the provider give the definitive answer. This retains valid custom
   model IDs that predate the local registry.
6. If no model in the chain is registered, reject launch as
   `NO_COMPATIBLE_MODEL`; do not borrow a static default from another provider.

Each harness implements model classification/normalization. Delete the prefix
heuristic in `project-store.ts` after all callers use the shared resolver.

## 6. One session-launch coordinator

Add `server/session-launch.ts` as the only production path allowed to call
`SessionRegistry.start()` for a new session. It accepts the requested role,
harness, model, executor class, permission mode, and the existing session
options, then:

```text
fresh readiness
  -> resolve effective harness
  -> resolve effective model from that harness's chain
  -> normalize permission mode for that harness
  -> emit resolution/rejection
  -> SessionRegistry.start(effective options)
```

Both `create_session` and `startMinionSession` await this coordinator. Resume,
wait-and-continue, and messages on an existing session retain the session's
already selected harness and do not re-route mid-conversation.

### 6.1 Visible, non-destructive fallback

On fallback, emit this session-scoped event before `session_created`/running:

```ts
interface SessionLaunchResolved {
  type: "session_launch_resolved";
  sessionKey: string;
  requested: { harness?: string; model?: string; permissionMode?: string };
  effective: { harness: string; model: string; permissionMode: string };
  reasons: Array<
    | "harness_not_ready"
    | "model_incompatible"
    | "permission_unsupported"
  >;
  transient: true;
}
```

The UI displays a persistent banner/badge for that session. Requested
`settings.json` and node fields remain unchanged. Runtime fields are stored
separately in session state so autosave cannot turn a temporary fallback into
a configuration migration. The Settings UI offers an explicit "Use these
defaults" action if the user wants to persist the effective choice.

If no harness is ready, emit `session_error` with code `HARNESS_NOT_READY`, the
redacted snapshot, and remediation. Do not create a SessionHost, worktree, or
task record. For a delegated task, leave/return the task to a retryable failed
state with the same actionable reason rather than timing out silently.

### 6.2 Authoritative permission propagation

- A Leader uses the requested/node permission mode, falling back to the
  project default and then safe `auto`.
- `assign_task` passes `settings.defaultPermissionMode` into the launch
  coordinator for every server-created Minion.
- The coordinator validates support against the effective harness. An
  unsupported mode falls back to `auto` and emits `permission_unsupported`;
  it never escalates to `bypassPermissions`.
- `minion_spawned` includes the effective `permissionMode`, `harness`, and
  `model` returned by the coordinator.
- `src/Canvas.tsx` consumes those fields and deletes its hard-coded
  `bypassPermissions` label.
- Contract tests assert that the value shown on the Minion node equals the
  value passed to `HarnessStartOptions`.

## 7. First-run and degraded-state UI

The existing desktop and mobile project choosers are the readiness entry
points; do not add a separate wizard that can disagree with them.

The choosers load `GET /api/readiness` because desktop `ProjectView` does not
create the WebSocket or `HarnessListProvider` until after a project is selected,
and mobile project creation likewise precedes a selected session view. Once a
project is open, `list_harnesses` supplies the same cached contract to settings
and session controls. The retry button uses `GET /api/readiness?refresh=1`.

- Show one card per production harness: Ready, Sign in, Runtime missing, Check
  timed out, or Check failed. Include a retry action and controlled remediation.
- Enable new-project/first-open initialization when at least one card is Ready.
- With neither ready, the app still loads, existing projects can be inspected,
  and settings can be edited. Creating a sidecar or starting a session shows the
  same `HARNESS_NOT_READY` guidance returned by the server.
- The new-project confirmation states the derived Leader and Minion defaults
  before writing them.
- The first empty project contains a compact explanation of effective harness
  and model, optional worktree isolation, approval before merge, data/log
  locations, and a harmless suggested task such as "Summarize this repository's
  structure without changing files."
- Do not modify Claude/Codex configuration or grant permissions on the user's
  behalf. Authentication commands are instructions, not subprocesses launched
  by the UI.

## 8. Preflight behavior

Preflight has two sections and a stable exit policy.

Host blockers:

- Node >= 22;
- the repository's declared pnpm version is available;
- git is executable;
- backend and frontend ports can bind on loopback;
- installed native dependencies load successfully. If `better-sqlite3` already
  loads, absence of a compiler is not a blocker; print toolchain guidance only
  when install/build evidence requires it.

Harness table:

- render the shared redacted snapshot;
- succeed when at least one production harness is ready;
- warn, but do not fail, for the other harness;
- fail when neither is ready, with exact login/runtime remediation.

All external checks use `execFile`/`spawn` with argument arrays, `shell: false`,
timeouts, injected dependencies, and bounded output. Unit tests cover paths
with spaces, missing commands, non-zero exits, malformed output, timeouts,
Claude-only, Codex-only, both, and neither.

## 9. Ordered pull requests

These PRs are deliberately ordered. File ownership is exclusive within each PR;
later PRs may build on earlier surfaces.

### PR 1 — Runtime and readiness contract

Owns:

- `server/harness/types.ts`
- `server/harness/index.ts`
- `server/harness/readiness-types.ts` (new)
- `server/harness/readiness.ts` (new)
- `server/harness/register-production.ts` (new)
- `server/session-host.ts` (registration imports only)
- `server/harness/claude/runtime.ts` (new), Claude harness/auth tests
- `server/harness/codex/runtime.ts` (new), `server/harness/codex/auth.ts`, Codex
  harness/auth tests

Delivers harness-owned same-runtime probes, redaction, timeout/caching behavior,
and removal of credential-file-existence readiness. It does not change project
or session behavior yet.

Gate: unit tests prove no secret/raw output escapes and the SDK launch path and
probe path receive the identical resolved executable.

### PR 2 — Safe commands and honest preflight

Owns:

- `package.json`
- `scripts/run.mjs` (new)
- `scripts/start.mjs` / `scripts/serve.mjs`
- `scripts/dev.mjs` (remove or reduce to compatibility wrapper)
- `scripts/preflight.mjs`
- `scripts/tailscale-serve.mjs`
- `server/index.ts` bind default only
- command/supervisor/preflight tests

Delivers the command table in section 3, loopback defaults, local binary
resolution, full-stack preview, and the shared readiness-backed preflight. The
`preflight` package script loads TypeScript through the repository's installed
`tsx`; it does not duplicate the readiness implementation in an `.mjs` file.

Gate: command tests prove default start/preview never invoke Tailscale, Vite-only
`dev` is impossible, signals stop both child processes, and no-auth preflight
fails with controlled guidance.

### PR 3 — Default and model resolution

Owns:

- harness model registries/policies and their tests
- `server/project-store.ts` and `server/project-store.test.ts`
- `server/routes/projects/core.ts` and route contract tests
- `server/routes/readiness.ts` (new), its mount, and route contract tests
- project settings types shared with the client

Delivers the readiness matrix, explicit first-sidecar settings, ordered model
chains, and preservation rules for existing projects. Deletes the prefix-only
compatibility helper.

Gate: table-driven tests cover all four readiness states, every role/executor
chain, missing-sidecar route behavior, legacy `defaultModel`, compatible custom
models, incompatible models, and proof that reads/fallbacks do not rewrite
existing `settings.json`.

### PR 4 — Authoritative session launch and UI state

Owns:

- `server/session-launch.ts` and tests
- `server/commands/create-session.ts`, command types/schemas/dispatcher tests
- `server/session-host*.ts`, `server/session-registry.ts`
- `server/task-tools/assign-task.ts` and tests
- `server/commands/list-harnesses.ts` and tests
- `src/use-socket.ts`, harness-list provider/types
- `src/api.ts`, `src/ProjectList.tsx`, `src/mobile/ProjectsScreen.tsx`, project
  chooser/readiness UI, session fallback UI
- `src/Canvas.tsx`, node defaults, and focused component tests

Delivers fresh launch validation for Leaders and Minions, visible transient
fallbacks, retryable readiness failures, and authoritative permission display.

Gate: integration tests prove browser and server spawn paths use the same
coordinator, no SessionHost/worktree is created on rejection, fallback does not
mutate persisted node/project settings, and displayed Minion permissions equal
the harness start options.

### PR 5 — Documentation, CI smoke, and release proof

Owns:

- `README.md`
- this document (status/links only)
- `.github/workflows/ci.yml`
- `tests/smoke/` and smoke fixtures

Delivers the public information architecture, automated clean-environment
coverage, and the release checklist. README sections are: local quick start,
prerequisites/auth, foreground and built preview, background service, optional
Tailscale/mobile, data/reset/troubleshooting.

Gate: link/doc checks pass and the automated matrix below is green.

## 10. Test matrix and CI design

No CI test reads real home credentials or calls a model provider. Fixture
executables implement only version/auth-status behavior and are selected through
the normal runtime override. A fake harness/session stream tests post-readiness
launch mechanics.

| Layer | Required cases |
|---|---|
| Readiness unit | Runtime missing; authenticated; unauthenticated; empty/malformed status; timeout; non-zero exit; concurrent de-duplication; cache expiry; redaction |
| Default resolver | Both; Codex only; Claude only; neither; stable exact settings objects |
| Model resolver | Explicit valid; alias; compatible custom; incompatible; harness switch; each role/executor chain; empty registry |
| Readiness route | Redacted cache read; explicit refresh; no project/WebSocket required; controlled probe failure |
| Project routes | New project succeeds with one harness; neither returns structured error before filesystem mutation; existing project opens without auth; missing sidecar is gated |
| Session command | Fresh revalidation; rejected launch creates no host/worktree; fallback event precedes creation; explicit settings remain unchanged |
| Minion spawn | Auth expires after Leader start; retryable task failure; effective harness/model/permission emitted and passed to runtime |
| Command supervisor | Foreground child health/signals; preview has backend; background PID lifecycle; Tailscale only on flag; loopback defaults |
| Client | Readiness cards; disabled initialization; remediation; fallback banner; no hard-coded permission |

CI jobs:

1. Existing `pnpm verify` suite.
2. Linux clean-install and command smoke with fixture auth runtimes.
3. No-auth smoke proving the app boots but initialization/session launch is
   rejected actionably.
4. Claude-only, Codex-only, and both-ready contract smokes using fixtures.
5. Windows command-supervisor job may begin as allowed-to-fail only if process
   group behavior is still unverified; public docs must label Windows
   experimental until it is required and green.

Real-provider release checks are manual because they require secrets and can
consume service quota:

- clean machine with Claude only: create project, Leader reply, delegated
  Minion reply;
- clean machine with Codex only: same;
- both ready: confirm mixed default and delegation;
- revoke auth after project creation: confirm fresh launch rejection/fallback;
- no Tailscale: local start and preview;
- opt-in Tailscale: background service and mobile HTTPS.

## 11. Migration and rollback

There is no destructive data migration.

- Existing `.minions/settings.json`, canvas nodes, and session history are read
  as written.
- Missing fields resolve in memory from readiness/model policy. Reading a
  project never writes the resolved value back.
- Existing explicit harness/model pairs that remain ready and compatible are
  used unchanged.
- Unready harnesses and incompatible models produce transient session fallback
  state. Only an explicit settings save persists a new preference.
- New sidecars receive readiness-derived explicit defaults; legacy
  `defaultModel` mirrors the Minion model for backward readers.
- Rollback can ignore the additive readiness/session-resolution wire fields and
  continue reading old settings. No DB downgrade is required.

Operational rollback for the command redesign is restoring package-script
bindings; it does not touch user projects. Tailscale configuration remains
isolated in its opt-in controller so local rollback cannot expose the server.

## 12. Release gates and definition of done

Do not publish the onboarding redesign until all of these are true:

- A clean clone with exactly one authenticated harness gets a green preflight,
  readiness-derived project defaults, and a successful first session.
- A machine with neither harness can boot and inspect the UI, but cannot create
  an unlaunchable sidecar/session; every blocked action shows a login/runtime
  fix.
- Preflight, project initialization, picker status, Leader launch, and Minion
  launch agree under the same injected readiness snapshot.
- Revoking auth between preflight and session creation is caught by the fresh
  launch probe.
- No readiness payload, log, or UI contains a token, raw CLI output, account
  identity, credential contents, or absolute credential/executable path.
- Existing explicit settings survive open, fallback, session completion, and
  autosave byte-for-byte unless the user explicitly saves settings.
- Effective session harness/model/permission are visible, and Minion permission
  display matches the runtime.
- `pnpm start`, `pnpm dev`, and `pnpm preview` are foreground full-stack and
  loopback by default; none invokes Tailscale.
- Optional background and Tailscale flows pass their smoke checks.
- Linux CI is required and green; any experimental platform is labelled rather
  than implied to be supported.

The core acceptance statement is: **with Claude or Codex authenticated, one is
enough to create a correctly configured project and launch both Leaders and
Minions; with neither authenticated, Minions fails before creating misleading
state and tells the user exactly how to become ready.**
