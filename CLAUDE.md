# Minions — Project Instructions

Project-specific guidance for any agent (or human) working in this repo.
The global standards in `~/.claude/CLAUDE.md` apply in full; this file
narrows them to this codebase. **Where the two conflict, this file wins.**

---

## North star

Minions is an infinite canvas in front of the Claude Agent SDK. The
architecture uses a typed event bus, an agent-type registry, and
graph-as-bus routing.

The testing rules below describe the layering model, file locations, and
what to test. They are the working agreement.

If you are about to change behaviour, the answer to "do I need a test?"
is yes by default. The next two sections say how.

---

## Testing is part of the change, not a follow-up

This is the hard rule for this repo:

1. **Tests live in the same commit as the code change.** A behaviour
   change with no test is incomplete — fix it before opening the PR.
2. **For pure logic** (reducers, parsers, schemas, layout math, MCP tool
   handlers, path guards) write a unit test colocated next to the file:
   `src/foo.ts` → `src/foo.test.ts`.
3. **For React components** with non-trivial behaviour, write a
   component test (`*.test.tsx`) — `@testing-library/react` queries,
   no snapshot of the full DOM tree.
4. **For new WS events or MCP tool surfaces**, add a contract test in
   `tests/contracts/`.
5. **For architectural invariants** (file size, no cross-tree imports,
   no direct broadcast), update or add a test in `tests/architecture/`.

If you can't figure out where a test should live, default to colocated
and ask in the PR.

### When refactoring

Use this test-first sequence:

```
1. Write a test that captures the current behaviour you must preserve.
2. Confirm it passes on today's code.
3. Refactor.
4. The same test, unchanged, passes on the new code.
```

If step 4 forces you to change the test, you've changed behaviour. Stop,
revert, or call it out in the PR with reasoning.

### When fixing a bug

1. Write a test that triggers the bug. It must fail.
2. Fix the bug. The test passes.
3. The test stays. Bug-regression tests are non-negotiable.

---

## The dev-loop commands

| Command | When |
|---|---|
| `pnpm test` | Watch mode. Run while you're working. |
| `pnpm test:run` | One-shot. Run before you stage. |
| `pnpm typecheck` | Run before you commit. CI runs the same. |
| `pnpm verify` | One-shot mirror of CI: typechecks, tests, license and system-model validation, then build. Run before you push. |
| `pnpm test:coverage` | Look at blind spots. Coverage is reported, not gated. |
| `pnpm agent:preflight -- --checkpoint <label>` | Run before delegating code edits to another agent/minion. Confirms git metadata is writable, no patch rejects remain, and dirty work has an explicit recovery checkpoint. |
| `prek run` | Local pre-commit gate (see `.pre-commit-config.yaml`). |

The CI workflow (`.github/workflows/ci.yml`) runs the same commands as
`pnpm verify` plus `pnpm install --frozen-lockfile`. If `pnpm verify`
passes locally, CI will pass too — that's the whole design.

### Pre-commit hook (one-time setup)

Per the global standard, install `prek` once per clone:

```bash
prek install
```

`.pre-commit-config.yaml` configures the hook to run `pnpm typecheck`
and `pnpm test:run` on commits that touch TS/TSX/JS/MJS files. It is
intentionally cheap — the suite finishes in well under a second on a
warm cache. Don't bypass it; if a hook fails, fix the cause.

---

## Delegating code edits to agents/minions

This repo allows parallel agent work only when each worker has an isolated
workspace or a clearly disjoint write set. Do not let a minion make code edits
directly on the shared main worktree unless the leader has explicitly chosen to
own the integration risk for that turn.

Before assigning code-edit work:

1. Create a recoverable checkpoint: commit, stash, or patch backup.
2. Run `pnpm agent:preflight -- --checkpoint <label>`.
3. Give the worker a narrow ownership boundary: files/modules it may edit.
4. Tell the worker it is not alone in the codebase and must not revert others'
   work.

Workers must not run `git reset`, `git checkout --`, `git clean`, stash/drop,
or commit on a shared branch. If a worker needs git operations, it needs its own
worktree and should report changed paths back to the leader for integration.

After a worker returns, the leader must inspect `git status --short` before
continuing and reconcile any unexpected changes before starting another task.

---

## Architectural invariants the suite enforces

These are tracked by `tests/architecture/` and gate CI.

| Invariant | Test |
|---|---|
| `server/*.ts` ≤ 400 lines | `file-size.test.ts` |
| No `from "../src/"` in `server/` (or vice versa) | `no-cross-tree-imports.test.ts` |
| No `broadcast(wss, ...)` outside the bus | `no-direct-broadcast.test.ts` |
| Every `WsCommandType` has a handler | `command-table.test.ts` |

New server files must be under 400 lines; split them if they grow.

---

## Where to look first

| If you're working on … | Read first |
|---|---|
| A new node type | `src/node-registry.ts`, `src/types.ts`, an existing minimal node like `src/nodes/MarkdownNode.tsx` |
| The chat / message feed | `src/sdk-messages.ts`, `src/streaming.ts`, the relevant node component |
| A new MCP tool for the leader | `server/task-tools/` (per-tool factories) + `server/render-tools.ts` |
| A new MCP tool for a minion | `server/minion-tools.ts` |
| The render DSL | `shared/render-dsl.ts` (single source of truth for types + schemas) and `server/render-tools.ts` (MCP tool surface) |
| A new WebSocket command | `server/commands/<name>.ts` + an entry in `server/commands/index.ts` `COMMAND_TABLE` |
| Session lifecycle (abort, query loop, persistence) | `server/session-host.ts` |
| Leader reply continuity / follow-up / resume | `server/work-item-continuation.ts`, `src/use-work-items.ts`, `server/commands/send-message.ts` |
| Worktree / approval flow | `server/worktree-*.ts`, `server/commands/approve-changes.ts`, `server/commands/*-merge.ts` |
| Persistence | `server/db.ts`, `server/project-store.ts` |
| Anything that looks "stringly typed" by role | `src/prompts/`, `server/index.ts` |

---

## Conventions worth repeating

- **Replace, don't deprecate.** When the new shape lands, delete the
  old one. No dual config formats, no compat shims.
- **No `setTimeout("wait for state")` in tests.** Use
  `await waitFor(...)` from `@testing-library/react`, or change the
  code to expose a promise.
- **No new mocks of our own modules.** Mock at boundaries (WS, FS, SDK).
  If you can't test a module without mocking it, the module needs a
  refactor first.
- **No new `broadcast(wss, ...)` call sites** outside `server/bus.ts`.
  The architecture test enforces this.
- **Files this codebase asks you to keep small:**
  `server/index.ts`, `src/Canvas.tsx`, `src/nodes/LeaderNode.tsx`,
  `src/nodes/ClaudeSessionNode.tsx`. They are oversized today and
  every PR should make at most a small dent or hold steady — never
  grow them. The size assertions in `tests/architecture/file-size.test.ts`
  enforce this.

---

## Typecheck coverage

`pnpm typecheck` (`tsc -b --noEmit`) walks all three tsconfig project
references: `tsconfig.app.json` (covers `src/`), `tsconfig.node.json`
(covers `vite.config.ts`), and `server/tsconfig.json` (covers
`server/`). The `tests/` and `scripts/` trees are still validated only
indirectly when vitest runs them via `tsx`.

---

## When in doubt

Two-question checklist before opening a PR:

1. Does `pnpm verify` pass locally?
2. Did I add or update at least one test for what I changed?

If both are yes, you're aligned with the working agreement. If either is
no, the PR isn't ready.
