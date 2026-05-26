# Minions — Project Context

A working brief for anyone (human or agent) about to make changes in this repo. Read once; reference as needed.

---

## 1. What this project is

**Minions** is an infinite-canvas UI on top of the Claude Agent SDK. It lets a user give a **Leader** agent a complex task; the Leader decomposes it, spawns parallel **Minion** agents, and tracks progress visually on the canvas. Each Minion runs in an isolated git worktree, and changes route through an explicit approval flow before merging back into the user's main branch.

- Status: early development, shared for private testing (see `README.md`).
- Storage: per-project SQLite — no env vars, no Docker required.
- Runtime model: local-only (binds to localhost). Frontend on **5173**, backend on **3141**.

---

## 2. Tech stack

| Layer | Stack |
|---|---|
| Frontend | React 19, Vite 8, TypeScript 6 |
| Backend | Node ≥ 22, Express 5, `ws` 8 (WebSocket), `better-sqlite3` |
| Agents | `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` (alt harness), echo harness (tests) |
| Validation | `zod` v4 (used as the shared DSL contract) |
| Test | Vitest 4, `@testing-library/react`, jsdom; Stryker for mutation runs |
| Package mgr | pnpm 10 (frozen lockfile in CI) |

Entry points:
- Frontend: `src/main.tsx` → `src/App.tsx` → `src/Canvas.tsx`
- Backend: `server/index.ts` (Express + WS dispatcher; intentionally thin)
- Dev launcher: `scripts/dev.mjs` (runs server + Vite together via `pnpm start`)

---

## 3. High-level architecture

```
Browser (5173)
  React canvas UI ──► WebSocket ──► Express + WS server (3141)
                                       │
                                       ├── Bus (server/bus.ts)            ← all broadcasts
                                       ├── Command table (commands/)      ← all WS commands
                                       ├── SessionHost(s)                 ← one per session
                                       ├── Harness registry (claude|codex|echo)
                                       ├── AgentType registry (leader|minion|default|card-composer)
                                       ├── MCP tools (task / render / reasoning-map / minion)
                                       ├── Worktree manager (git isolation + approval flow)
                                       └── SQLite (per-project state, via server/db.ts)
```

Four pluggable registries are the spine:

1. **Node type registry** — `src/node-registry.ts`. Each canvas node type (Leader, Minion, Markdown, Image, RenderNode, Routine, ContextGroup, Folder, FileViewer, ClaudeSession) self-registers a `NodeTypeDefinition` from `src/types.ts`. Used by the canvas to render and by context extraction to gather text/image attachments to feed into agent sessions.

2. **Agent type registry** — `server/agents/registry.ts`. Each agent role (`leader`, `minion`, `default`, `card-composer`) implements `AgentType` (`server/agents/types.ts`) and self-registers via `registerAgentType()`. The `AgentType` interface defines `buildSystemPrompt`, `getToolGroups`, `wantsWorktree`, `onComplete`, `detectsSubagents`. Adding a new role is ~50 lines.

3. **Harness registry** — `server/harness/index.ts`. Each LLM harness (`claude`, `codex`, `echo`) implements `AgentHarness` (`server/harness/types.ts`). This is the model-agnosticism layer: agent code talks to a normalized event stream and tool-registration interface; the harness adapts to its SDK. Spec: `docs/model-agnosticism-spec.md`.

4. **Command table** — `server/commands/index.ts`. A single `COMMAND_TABLE` object keyed by `WsCommandType` with a per-command handler. The type-level `satisfies CommandTable` makes missing handlers a compile error — there is no `switch` statement. Add a command by creating `server/commands/<name>.ts` and a row in the table.

---

## 4. Key directories

### Frontend — `src/`
- `Canvas.tsx`, `CanvasNode.tsx`, `EdgeRenderer.tsx`, `CanvasMiniMap.tsx` — the infinite canvas and edge routing
- `canvas-state.ts` — reducer for `CanvasAction` (`ADD_NODE`, `MOVE_NODE`, `RESIZE_NODE`, etc.)
- `graph.ts` / `graph-runtime.ts` — connection contracts between node ports (typed protocols)
- `nodes/` — one file per node type (e.g. `LeaderNode.tsx`, `MinionNode.tsx`, `RenderNode.tsx`, `RoutineNode.tsx`, `MarkdownNode.tsx`, `ClaudeSessionNode.tsx`, `ImageNode.tsx`, `ContextGroupNode.tsx`, `FolderNode.tsx`, `FileViewerNode.tsx`)
- `prompts/` — system prompts shared with the frontend (e.g. `context-explorer.ts`)
- `skills/` — built-in skills (`api-design`, `architect`, `code-review`, `commit`, `debug`, `refactor`, `security-audit`, `simplify`, `test-generator`, etc.) plus `registry.ts`
- `KanbanBoard.tsx` / `use-kanban.ts` / `kanban-types.ts` — task-board view that can launch Leaders
- `SkillsBrowser.tsx`, `SkillEditor.tsx`, `McpServersBrowser.tsx`, `SettingsMenu.tsx` — auxiliary UIs
- `sdk-messages.ts`, `streaming.ts`, `session-stream.ts`, `use-session-stream.ts`, `message-chunks.ts` — message rendering pipeline
- `use-socket.ts`, `api.ts` — WS + REST client wiring
- `feature-flags.ts`, `debug.ts`, `themes.ts`, `palette.ts` — cross-cutting utilities

### Backend — `server/`
- `index.ts` — Express + WS bootstrap, auth bootstrap, command dispatch. **Kept thin on purpose.**
- `bus.ts` — typed event bus. **All broadcasts go through here**; a fitness test forbids `broadcast(` outside this file.
- `session-host.ts` (+ `session-host-run.ts`, `session-host-config.ts`, `session-host-context-recovery.ts`) — one host per session; owns abort controller, SDK query loop, event buffer, task/render state, worktree handle, write-through SQLite persistence
- `session-registry.ts`, `session-persist.ts`, `session-repo.ts` — session indexing + persistence
- `agents/` — `leader.ts`, `minion.ts`, `default.ts`, `card-composer.ts`, `registry.ts`, `types.ts`, barrel `index.ts`
- `harness/` — `claude/`, `codex/`, `echo/` subtrees; `types.ts` defines `AgentHarness`, `NormalizedEvent`, `NormalizedToolDef`; `index.ts` is the registry
- `commands/` — one file per WS command; `index.ts` defines `COMMAND_TABLE`; `types.ts` defines `CommandHandler` / `CommandContext` / `WsCommandType`
- `routes/` — REST routes (`projects.ts`, `files.ts`); mounted under `/api/projects` and `/api/files` with bearer-token auth
- `task-tools.ts` — Leader-side MCP task management (plan/assign/complete/get_status/set_task_name/wait_and_continue/request_approval)
- `render-tools.ts` — MCP dashboard tools (`render_set`, `render_patch`, `render_append`, `render_remove`)
- `reasoning-map-tools.ts` — MCP reasoning-map tools
- `minion-tools.ts` — Minion-side reporting tools (`report_done`, etc.)
- `worktree*.ts` — git worktree lifecycle (`worktree.ts`, `worktree-create.ts`, `worktree-diff.ts`, `worktree-merge.ts`, `worktree-exec.ts`, `worktree-types.ts`)
- `db.ts`, `project-store.ts`, `mcp-server-store.ts`, `skills.ts`, `routine-store.ts`, `routine-persist.ts`, `routine-registry.ts` — persistence and stores
- `mcp-bridge/` — bridging external MCP servers
- `path-guard.ts` — guard for filesystem path access (defends `routes/files.ts`)
- `ws-connection.ts`, `ws-config.ts` — WS lifecycle, payload limits

### Shared — `shared/`
Code imported by both `src/` and `server/`:
- `render-dsl.ts` (+ `render-base.ts`, `render-form.ts`, `render-chart.ts`, `render-containers.ts`, `render-artifacts.ts`, `render-defaults.ts`) — Zod-schema-backed dashboard component DSL; **single source of truth** for client and server
- `ws-envelope.ts` — `WsEnvelope` shape and topic helpers (`sessionTopic`, `projectTopic`, `GLOBAL_TOPIC`)
- `normalized-event.ts` — harness-agnostic event shape
- `reasoning-map.ts`, `reasoning-map-dashboard.ts` — reasoning-map state and rendering

### Tests — `tests/`
- `tests/contracts/` — cross-tree contracts (WS envelope round-trip, render-DSL round-trip, routes, normalized event)
- `tests/architecture/` — fitness tests (file size ceilings, no cross-tree imports, no direct broadcast/ws-send, banned assertions, no Claude SDK outside `harness/`, no real-home writes from tests, baselines monotonic)
- `tests/fixtures/` — builders and recorded SDK message streams (`.jsonl`)
- `tests/harness/` — WS replay harness and session-stream snapshot tests

### Scripts & docs
- `scripts/dev.mjs` — concurrently runs server + Vite (used by `pnpm start`)
- `scripts/preflight.mjs` — validates `claude` CLI / Node / pnpm / git
- `scripts/setup-permissions.mjs` — writes `.claude/settings.json` allowlist
- `docs/testing-strategy.md` — the working agreement on tests (mandatory reading before adding behaviour)
- `docs/model-agnosticism-spec.md` — harness layer design
- `docs/codex-harness-spec.md`, `docs/bundling-spec.md`, `docs/reasoning-graph-*` — feature specs

---

## 5. Key abstractions

- **`CanvasNode<T>`** (`src/types.ts`) — generic node carrying `id`, `type`, `position`, `size`, and a typed `data` blob. `CanvasAction` is the reducer command union.
- **`NodeTypeDefinition`** — registry entry for a node type; declares `defaultSize`, `render` component, `ownsChildrenOfType`, `providesContext`, `isContainer`, `extractContent`, `extractAttachments`, `sanitizeOnLoad`.
- **`ContextItem` / `ContextAttachment`** — what gets fed into a Leader session as user-supplied context. Attachments today are base64 images (`image/jpeg|png|gif|webp`) — they ride the `attachments` field on `create_session` and become real `ImageBlockParam`s to the SDK.
- **`ThinkingConfig`** — `enabled` + `effort` (`low|medium|high|xhigh|max`) + `display` (`summarized|omitted`). Adaptive thinking; we deliberately don't expose `budget_tokens`.
- **`AgentType`** (`server/agents/types.ts`) — the role plug-in. `buildSystemPrompt`, `getToolGroups`, `wantsWorktree`, `onComplete?`, `detectsSubagents?`. Roles today: `leader`, `minion`, `default`, `card-composer`.
- **`AgentHarness`** (`server/harness/types.ts`) — the LLM plug-in. Normalizes events into `NormalizedEvent`, wraps `NormalizedToolDef[]` into the harness's own tool format. Harnesses: `claude`, `codex`, `echo`.
- **`Bus`** (`server/bus.ts`) — `emitToSession`, `emitToProject`, `unicastGlobal`, etc. Every broadcast goes through a `WsEnvelope { topic, ...payload }`; the client filters by topic.
- **Render DSL** (`shared/render-dsl.ts`) — typed component vocabulary (`metric`, `progress`, `status`, `table`, `chart`, `form`, `section`, `tabs`, `image`, `file-preview`, …). Each component has a stable `id` so the server can `render_patch` with targeted updates instead of resetting the dashboard.
- **`WsCommandType` / `COMMAND_TABLE`** (`server/commands/`) — every WS command name and its handler. `satisfies CommandTable` enforces exhaustiveness at compile time.
- **Worktree flow** (`server/worktree*.ts`, `server/commands/approve-changes.ts`, `merge-worktree.ts`, `discard-worktree.ts`) — Leader's changes live on an isolated branch; the user must explicitly approve before merge. The Leader is expected to call `request_approval` as its final action.

---

## 6. Execution flow (Leader/Minion happy path)

1. User adds a Leader node and types a prompt. Frontend sends `create_session` over WS.
2. `server/commands/create-session.ts` builds a `SessionHost` via `session-host.ts`, which calls `ensureWorktree` (if `AgentType.wantsWorktree`) and `buildHarnessStartOpts`.
3. The host calls the registered `AgentHarness.start(...)`. The Claude harness wraps `@anthropic-ai/claude-agent-sdk`'s `query()` loop.
4. Tools registered for the Leader come from `agents/leader.ts.getToolGroups` — chiefly `task-tools.ts` and `render-tools.ts`, plus any MCP servers / skills the user armed.
5. The Leader uses task tools (`plan_task`, `assign_task`, `complete_task`, etc.) and render tools (`render_set`, `render_patch`, ...) to drive the canvas live.
6. `assign_task` calls back into the host's `startMinionSession`, spawning a new session with the `minion` agent type — inheriting the parent worktree.
7. Minions report results via `minion-tools.ts` → `AgentType.onComplete` propagates back into the Leader's `TaskManagerState`.
8. When done, Leader calls `request_approval`. The user clicks Approve or Discard in the UI → `approve-changes` / `discard-worktree` runs `merge-worktree.ts` / cleanup.

---

## 7. Development workflow

| Command | Purpose |
|---|---|
| `pnpm start` | Full dev stack (server + Vite via `scripts/dev.mjs`) |
| `pnpm dev` | Vite only |
| `pnpm server` | Backend only (`tsx server/index.ts`) |
| `pnpm test` | Vitest watch |
| `pnpm test:run` | Vitest one-shot (CI mode) |
| `pnpm typecheck` | `tsc -b --noEmit` across the three project refs |
| `pnpm verify` | Full local CI gate: `typecheck && typecheck:server && test:run && build` |
| `pnpm preflight` | Validate prerequisites |
| `pnpm configure` | Pre-approve in-process MCP tools (`.claude/settings.json`) |

Three `tsconfig` project refs: `tsconfig.app.json` (src), `tsconfig.node.json` (vite config), `server/tsconfig.json` (server). Tests are validated when vitest executes them via `tsx`.

### Testing rules that bite (`CLAUDE.md` + `docs/testing-strategy.md`)

- **Tests ship in the same commit as the behaviour change.** Pure logic → colocated `*.test.ts`. Components → `*.test.tsx` with RTL queries (no full-DOM snapshots). New WS / MCP surfaces → contract test in `tests/contracts/`. Architectural invariants → `tests/architecture/`.
- **Refactor-first arrow:** write a test that captures current behaviour, confirm it passes, refactor, confirm it still passes unchanged. If you had to change the test, you changed behaviour — call it out.
- **Bug-fix arrow:** write a failing test that triggers the bug, then fix.
- **Mocks at boundaries only** (`ws`, `fs`, `better-sqlite3`, `child_process`, Anthropic SDK). Don't mock modules we own.

### Architecture invariants gated in CI

| Invariant | Test |
|---|---|
| `server/*.ts` ≤ 400 lines | `tests/architecture/file-size.test.ts` |
| No `from "../src/"` in `server/` (or vice versa) | `no-cross-tree-imports.test.ts` |
| No `broadcast(wss, ...)` outside `server/bus.ts` | `no-direct-broadcast.test.ts` |
| No direct `ws.send` outside the bus | `no-direct-ws-send.test.ts` |
| No `@anthropic-ai/claude-agent-sdk` import outside `server/harness/claude/` | `no-claude-sdk-outside-harness.test.ts` |
| Architecture baselines never ratchet up | `baselines-monotonic.test.ts` / `no-baseline-ratchet-up.test.ts` |
| Every `WsCommandType` has a handler | enforced by `satisfies CommandTable` (compile-time) |

Files explicitly called out in `CLAUDE.md` as "do not grow":
`server/index.ts`, `src/Canvas.tsx`, `src/nodes/LeaderNode.tsx`, `src/nodes/ClaudeSessionNode.tsx`. They are oversized today; every PR holds steady or shaves a little.

### Pre-commit

`prek install` enables `.pre-commit-config.yaml`, which runs `pnpm typecheck` + `pnpm test:run` on touched TS/TSX/JS/MJS files. Don't `--no-verify`; fix the cause.

---

## 8. Conventions worth knowing

- **Replace, don't deprecate.** No dual config formats, no compat shims. When new shape lands, the old one goes.
- **No `setTimeout` "wait for state" in tests** — use `waitFor` or expose a promise.
- **Don't grow `server/index.ts`.** New work goes into `commands/` or new modules.
- **All bus traffic is enveloped** with a topic; the server doesn't track per-socket subscriptions today, clients filter on receipt.
- **Skills can be "armed" onto Minions** at `assign_task` time; the catalog lives in `src/skills/built-in/` and `server/skills.ts`.
- **REST surface is small and bearer-authed.** `/api/auth/token` (localhost-only) hands out a random per-run token; `/api/projects/*` and `/api/files/*` require `Authorization: Bearer …`.

---

## 9. Current state notes (as of this snapshot)

- The Claude harness is the production path. Codex and Echo harnesses exist; Echo is for tests.
- Worktree isolation + approval is fully wired (`commands/approve-changes.ts`, `merge-worktree.ts`, `force-merge.ts`, `theirs-merge.ts`, `retry-merge.ts`, `discard-worktree.ts`).
- Kanban board can launch Leaders directly and reflects progress through columns.
- Routines (`server/routines/`, `src/RoutineEditor.tsx` + workspace components) are a scheduled/recurring run system, with `start_routine` / `abort_routine` / `list_routines` commands.
- Reasoning maps are an experimental structured-reasoning layer (`shared/reasoning-map.ts`, `server/reasoning-map-tools.ts`) with their own MCP tools and dashboard rendering.
- `docs/archive/` holds historical specs (phase-5 work, testing-gaps audit) — they explain the *why* behind several current invariants.

---

## 10. Quick lookup table

| You're working on… | Read first |
|---|---|
| New node type | `src/node-registry.ts`, `src/types.ts`, `src/nodes/MarkdownNode.tsx` (minimal example) |
| Chat / message feed | `src/sdk-messages.ts`, `src/streaming.ts`, relevant `src/nodes/*Node.tsx` |
| New Leader MCP tool | `server/task-tools.ts`, `server/render-tools.ts` |
| New Minion MCP tool | `server/minion-tools.ts` |
| Render DSL change | `shared/render-dsl.ts` (+ family files) — both client and server import from here |
| New WS command | `server/commands/<name>.ts` + entry in `commands/index.ts` `COMMAND_TABLE` + add to `WsCommandType` in `commands/types.ts` |
| Session lifecycle | `server/session-host.ts` (+ `session-host-run.ts`, `-config.ts`, `-context-recovery.ts`) |
| New agent role | `server/agents/<role>.ts` implementing `AgentType`, then add to `server/agents/index.ts` barrel |
| New harness | `server/harness/<name>/index.ts` registering an `AgentHarness`, then import in `server/session-host.ts` |
| Worktree / approval | `server/worktree*.ts`, `server/commands/approve-changes.ts`, `merge-worktree.ts`, `discard-worktree.ts` |
| Persistence | `server/db.ts`, `server/project-store.ts`, `server/session-persist.ts`, `server/session-repo.ts` |

---

## 11. Two-question PR checklist

1. Does `pnpm verify` pass locally?
2. Did I add or update at least one test for what I changed?

If yes/yes, ship it. If either is no, the PR isn't ready.
