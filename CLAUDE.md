# Minions — Project Instructions

Project-specific guidance for any agent (or human) working in this repo.
The global standards in `~/.claude/CLAUDE.md` apply in full; this file
narrows them to this codebase. **Where the two conflict, this file wins.**

---

## North star

Minions is an infinite canvas in front of the Claude Agent SDK. The
codebase is in the middle of a five-phase architecture refactor described
in `docs/architecture-review-2026-04-16.md`. The refactor moves us from a
WebSocket firehose + monolithic `server/index.ts` toward a typed bus, an
agent-type registry, and a graph-as-bus routing model.

Two documents govern day-to-day work:

| Doc | What it gives you |
|---|---|
| `docs/testing-strategy.md` | Layering model, file locations, what to test and what not to test. The working agreement. |
| `docs/refactor-test-plan.md` | Per-phase pre-flight / in-flight / post-flight test gates. Read the section for the phase you're touching before you write code. |

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

### When refactoring (the situation we are in)

Use the test-first arrow from `docs/testing-strategy.md` §6:

```
1. Write a test that captures the current behaviour you must preserve.
2. Confirm it passes on today's code.
3. Refactor.
4. The same test, unchanged, passes on the new code.
```

If step 4 forces you to change the test, you've changed behaviour. Stop,
revert, or call it out in the PR with reasoning. This is the safety net
that lets us delete ~3000 lines in Phase 1 without holding our breath.

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
| `pnpm verify` | One-shot mirror of CI: typecheck + test:run + build. Run before you push. |
| `pnpm test:coverage` | Look at blind spots. Coverage is reported, not gated. |
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

## Architectural invariants the suite enforces

These are tracked by `tests/architecture/` and gate CI. They map directly
to flaws in the architecture review.

| Invariant | Test | Today's allowlist (in `tests/architecture/baselines.ts`) |
|---|---|---|
| `server/*.ts` ≤ 400 lines | `file-size.test.ts` | `index.ts`, `task-tools.ts`, `worktree.ts` — must shrink by Phase 5 |
| No `from "../src/"` in `server/` (or vice versa) | `no-cross-tree-imports.test.ts` | One: `server/index.ts` → `../src/prompts/minion-system.ts`. Removed in Phase 3. |
| No `broadcast(wss, ...)` outside the bus (after Phase 2) | `no-direct-broadcast.test.ts` | Snapshotted count today; must equal zero from Phase 2 onward |

When you touch any of these areas, the rule is **the count never grows
and the allowlist never gains new entries**. Reductions are always
welcome — when you remove a violation, edit `baselines.ts` to ratchet
the count down so we can never regress.

---

## Where to look first

| If you're working on … | Read first |
|---|---|
| A new node type | `src/node-registry.ts`, `src/types.ts`, an existing minimal node like `src/nodes/MarkdownNode.tsx` |
| The chat / message feed | `src/sdk-messages.ts`, `src/streaming.ts`, the relevant node component |
| A new MCP tool for an agent | `server/task-tools.ts`, `server/render-tools.ts`, `server/minion-tools.ts` |
| The render DSL | `src/render-dsl.ts` (client union) and `server/render-tools.ts` (server schema) — these will be unified in Phase 2 |
| Worktree / approval flow | `server/worktree.ts`, `server/index.ts` `runSession` |
| Persistence | `server/db.ts`, `server/project-store.ts` |
| Anything that looks "stringly typed" by role | the architecture review F6 / F14, `src/prompts/`, `server/index.ts:191` |

---

## Conventions worth repeating

- **Replace, don't deprecate.** When the new shape lands, delete the
  old one. No dual config formats, no compat shims. The architecture
  review's Phase 1 explicitly suggests removing `ClaudeSessionNode` if
  `SessionHost` covers its uses.
- **No `setTimeout("wait for state")` in tests.** Use
  `await waitFor(...)` from `@testing-library/react`, or change the
  code to expose a promise.
- **No new mocks of our own modules.** Mock at boundaries (WS, FS, SDK).
  If you can't test a module without mocking it, the module needs a
  refactor first.
- **No new `broadcast(wss, ...)` call sites** outside `server/bus.ts`
  once Phase 2 lands. The architecture test already counts them.
- **Files this codebase asks you to keep small:**
  `server/index.ts`, `src/Canvas.tsx`, `src/nodes/LeaderNode.tsx`,
  `src/nodes/ClaudeSessionNode.tsx`. They are oversized today and
  every PR should make at most a small dent or hold steady — never
  grow them. The size assertions in `tests/architecture/file-size.test.ts`
  enforce this.

---

## Known issues (fix-first before expanding scope)

These were discovered while wiring the workflow-integration in this
repo and are **not fixed** here — they deserve their own focused PR.
List them up top so any new session notices immediately.

### `pnpm typecheck` is currently a no-op

The root `tsconfig.json` has `"files": []` with only `references`.
`tsc --noEmit` in reference-mode without `-b` typechecks nothing.
The real type gate today is `pnpm build`, which runs `tsc -b && vite build`.

**Fix:** change `"typecheck": "tsc --noEmit"` to
`"typecheck": "tsc -b --noEmit"` so the same project references are walked.
Before flipping the switch, fix the pre-existing errors below — otherwise
the new typecheck immediately fails on `main`.

### `pnpm build` fails on `main` today

`tsc -b --noEmit` surfaces **~550 lines of type errors across 31 files**
(scope verified at start of Phase 1). Initial estimate undercounted —
the errors are not just SDK drift in `streaming.ts` / `use-socket.ts`,
they include broad `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` failures across most of `src/`.

Concentration:
- `src/Canvas.tsx`, `src/CanvasNode.tsx`, `src/App.tsx` —
  `exactOptionalPropertyTypes` violations on prop passing
- `src/nodes/*.tsx` — most node files have one or more errors
- `src/use-socket.ts`, `src/use-autosave.ts`, `src/use-kanban.ts`,
  `src/streaming.ts` — index-signature + missing-args errors
- `src/render-dsl.test.ts`, `src/sdk-messages.test.ts`,
  `src/streaming.test.ts` — stale casts

**Scope:** this is its own multi-session refactor (probably 3–5 focused
PRs grouped by error class). Do NOT attempt as part of a feature PR.

Until it's drained, `pnpm verify` fails at the `build` step. The
`pnpm test:run` gate (Vitest) is unaffected — tests run regardless of
type errors in dependencies, so the 214-test suite is the operating gate
for now.

---

## When in doubt

Two-question checklist before opening a PR:

1. Does `pnpm verify` pass locally?
2. Did I add or update at least one test for what I changed?

If both are yes, you're aligned with the working agreement. If either is
no, the PR isn't ready.
