# Testing Strategy — Minions Canvas

**Status:** Active. This is the default working agreement for tests in this repo.
**Companion document:** [`refactor-test-plan.md`](./refactor-test-plan.md) — phase-by-phase
test plan that operationalises this strategy against the architecture refactor.

---

## 1. Why this exists

The repo now ships a baseline of 214 automated tests across 12 files —
unit, contract-shape, and architecture-fitness layers — installed as
the test net for the upcoming refactor. The architecture review
(`docs/architecture-review-2026-04-16.md`) outlines a five-phase refactor that
will rewrite session hosting, the WebSocket bus, the agent role model, and the
canvas controller. Without that test baseline the refactor would rely on manual
regression — not credible at the size of the changes (~3000 lines of
session-hosting code is being deleted in Phase 1 alone).

This document defines:

- The **layers** of testing we use (and the layers we deliberately don't).
- The **tooling** and conventions.
- The **development workflow** — when tests are written, where they live, what
  CI gates look like.
- The **scope rules** — what to test, what not to test, and how to decide.

The companion document, `refactor-test-plan.md`, takes each refactor phase and
spells out the specific tests that must exist before, during, and after.

---

## 2. Goals (and non-goals)

**Goals.**

1. Catch regressions in pure logic (reducers, schemas, parsers, layout) on
   every commit.
2. Pin the contract between agents (MCP tool calls + WS broadcasts) and the
   client UI so the refactor doesn't break the live conversation surface.
3. Catch architectural drift via fitness tests (file size, cross-tree imports,
   broadcast call sites) — same idea as the global CLAUDE.md "Verify at every
   level."
4. Make the test command short enough that "run tests before commit" is a
   reflex, not a chore (`pnpm test` should finish in seconds for a focused
   suite).

**Non-goals.**

- 100 % line coverage. Coverage is a diagnostic, not a target — we measure it
  but don't gate on a percentage.
- Snapshot tests of rendered DOM trees. They drift, they're noisy, and they
  test implementation rather than behaviour.
- End-to-end tests through a real browser before Phase 4. Playwright/Cypress
  are valuable but not until the bus and persistence work is done — testing
  the firehose architecture would lock it in.
- Mocking what we own. We don't mock our own reducers, our own DSL, or our
  own MCP tool factories. We test them directly. We mock only at the WS, FS,
  and SDK boundaries.

---

## 3. The layers

We use a thin pyramid: most value is in the bottom two layers.

```
┌──────────────────────────────────────────────────────────────┐
│  L5 — End-to-end (manual until Phase 4; Playwright after)    │
├──────────────────────────────────────────────────────────────┤
│  L4 — Architecture fitness (no mock, walks the source tree)  │
├──────────────────────────────────────────────────────────────┤
│  L3 — Component / interaction (RTL + jsdom; SessionHost etc) │
├──────────────────────────────────────────────────────────────┤
│  L2 — Contract (WS envelope, MCP tool I/O, schema parity)    │
├──────────────────────────────────────────────────────────────┤
│  L1 — Unit (pure functions: reducers, DSL, parsers, layout)  │
└──────────────────────────────────────────────────────────────┘
```

### L1 — Unit tests

**Target.** Pure functions. No I/O, no React, no WS.

**Tool.** vitest, run in node.

**Where.** Colocated with the file under test: `src/render-dsl.test.ts`,
`server/task-tools.test.ts`. This makes the test obvious to find when reading
the file and means a refactor that moves a file moves its tests with it.

**Examples in this repo.**

| Module | What we test |
|---|---|
| `src/canvas-state.ts` | every `canvasReducer` action, `useCanvasHistory` undo/redo limits |
| `src/render-dsl.ts` | `applyRenderMessage` for set / patch / append / remove, id collisions |
| `src/graph.ts` | `canConnect` direction + protocol matrix, `canAcceptContextConnection` lock |
| `src/graph-runtime.ts` | `graphReducer` add/remove/idempotent, `dispatchMessage` fan-out, `createEdge` validation |
| `src/sdk-messages.ts` | every SDK message subtype → display message mapping; thinking/tool/text split |
| `src/streaming.ts` | `extractStreamDelta` happy + nested + missing fields |
| `src/canvas-utils.ts` | `snapToGrid` boundary, `findNonOverlappingPosition` ring search, `pushNodesFromRect` direction |
| `src/auto-layout.ts` | cluster bounding rects, leader-with-no-context, isolate flow, group-member delta propagation |
| `server/path-guard.ts` | home-dir check, `..` rejection, register/validate/unregister round-trip |

**Style.**

- Tests describe behaviour, not implementation. Test names read as facts:
  `"createEdge returns null when source is an input port"`, not
  `"createEdge calls canConnect"`.
- One assertion per intent. Multiple assertions per test are fine when they
  prove the same fact (e.g. shape + value).
- No shared mutable state between tests. Build fixtures in each test or in a
  factory function.
- Test the edges and errors, not just the happy path (per global CLAUDE.md).

### L2 — Contract tests

**Target.** The shape and behaviour of typed messages between agent ↔ server,
server ↔ client, and the MCP tool surface.

**Tool.** vitest. Backed by `zod` schemas where available.

**Where.** `tests/contracts/` (root-level), so it's clear they span both
trees.

**Examples we will add as the refactor lands.**

- **Render DSL parity.** The server's `componentSchema` (`server/render-tools.ts:37`)
  and the client's `RenderComponent` union (`src/render-dsl.ts:14`) must
  describe the same set of values. After Phase 2 there will be one shared
  source of truth — the contract test goes from a parity check to a
  schema-import test.
- **WS envelope.** Once Phase 2 lands `shared/ws-envelope.ts`, every server
  broadcast must produce a payload that parses against the envelope schema.
  Test: take a recorded broadcast, parse it, assert no errors, assert the
  topic is one of the known forms.
- **MCP tool contracts.** Each MCP tool has a Zod input schema. Test the
  factory by calling `tool.handler(args)` directly and asserting on the
  emitted broadcast and updated state. No SDK runtime involved.
- **Task-state transitions.** `plan_task → assign_task → complete_task` and
  guard transitions (re-assign of completed task is a no-op).

### L3 — Component / interaction tests

**Target.** React components whose behaviour is non-trivial. Today that's
mostly the SessionHost we'll extract in Phase 1, but it also includes the
RenderNode (which interprets the DSL into actual elements), the TaskBoard,
the EdgeRenderer port-anchor math, and the ApprovalBar.

**Tool.** vitest + jsdom + `@testing-library/react`.

**Where.** Colocated: `src/components/SessionHost.test.tsx`.

**Conventions.**

- Test the **observable behaviour** — what the user sees and what events the
  component emits. Don't reach into internals (no `wrapper.instance()`,
  no testing of `useRef` values).
- Use `@testing-library` queries that mirror real interactions
  (`getByRole`, `getByText`), not test-IDs unless the role is genuinely
  unavailable.
- Mock at the seam: `useSocket` is mocked to return a fake bus that the test
  drives. The component itself is real.
- For SessionHost specifically, build a **WS replay harness** (see
  `refactor-test-plan.md` Phase 1) that takes a JSON file of recorded
  `SdkMessage`s and feeds them into the component, then asserts on the
  visible message feed. This is the safety net for the
  LeaderNode/MinionNode/ClaudeSessionNode collapse.

**What we won't snapshot.** Full DOM trees. They are noisy, capture
incidental ordering, and break with every CSS tweak. Prefer asserting the
specific things that matter.

### L4 — Architecture fitness tests

**Target.** Properties of the codebase, not its behaviour.

**Tool.** vitest test files that walk the source tree with `fs` + `glob`
or use `ts-morph` for AST queries when needed.

**Where.** `tests/architecture/`.

**Why.** The architecture review identifies four invariants we want to hold
during the refactor. Encoding them as tests means CI catches drift the
moment a PR introduces it, instead of waiting for a quarterly review.

**Invariants we enforce.**

| Invariant | Enforced by |
|---|---|
| `server/*.ts` ≤ 400 lines | `tests/architecture/file-size.test.ts` walks `server/`, fails on any file over 400 LOC. Maintains an allowlist of files we know are oversized today; CI fails if a file *not in the allowlist* exceeds, or if an allowlisted file grows. |
| No imports across `src/` ↔ `server/` (single allowlisted exception today) | `tests/architecture/no-cross-tree-imports.test.ts` greps for `from "../src/"` in `server/` and `from "../server/"` in `src/`. The single `MINION_SYSTEM_PROMPT` import is the documented exception, removed in Phase 3. |
| No new direct `broadcast(wss, ...)` after `server/bus.ts` lands (Phase 2) | `tests/architecture/no-direct-broadcast.test.ts` greps for the call site, ignoring the bus implementation itself. |
| No new `type === "<literal>"` branches outside the node registry | added in Phase 4 once the registry has the necessary fields. |

These tests are intentionally cheap. They run as part of `pnpm test` and
they don't need to be fast — they're scanning a small repo.

### L5 — End-to-end

Deferred until Phase 4 lands the typed bus and graph-routed messaging. Until
then, "spin up the server and click around" remains the manual smoke test.
Once persisted sessions exist (Phase 4), we add Playwright that:

1. Boots the server with a tmpdir SQLite.
2. Opens a fixture project with one Leader.
3. Sends a scripted prompt that triggers `plan_task → assign_task → minion completes → leader approves`.
4. Asserts on the visible canvas state and on the persisted DB.

We deliberately avoid building this earlier because (a) it would lock in the
broadcast firehose and (b) the Phase 1–3 changes are easier to verify with
unit + replay tests than with a brittle browser run.

---

## 4. Tooling

| Concern | Tool | Notes |
|---|---|---|
| Test runner | **vitest** | Already conforms to global CLAUDE.md preferences. |
| DOM | **jsdom** | jsdom for React component tests; node env for the rest. |
| Component queries | **@testing-library/react** + **@testing-library/jest-dom** | `getByRole`, `getByText`. Avoid `getByTestId` unless the role is unavailable. |
| Coverage | **@vitest/coverage-v8** | Reported, not gated, in CI. Used to find blind spots, not to enforce a number. |
| Mocking | vitest's `vi.fn`, `vi.mock` | Mock at boundaries (WS, FS, SDK). Don't mock our own modules. |
| Schema testing | **zod** (already a dep) | Use the production schemas in tests; don't redefine. |

We do **not** add jest, mocha, sinon, msw, enzyme, or chai. Vitest covers
each of those use cases and adding more frameworks fragments the test surface.

### Project layout

```
src/
  graph.ts
  graph.test.ts                 ← colocated unit tests
  components/
    SessionHost.tsx
    SessionHost.test.tsx        ← colocated component tests
server/
  task-tools.ts
  task-tools.test.ts
tests/
  contracts/                    ← cross-tree contract tests
    render-dsl-parity.test.ts
    ws-envelope.test.ts
  architecture/                 ← fitness tests
    file-size.test.ts
    no-cross-tree-imports.test.ts
  fixtures/                     ← shared test data
    sdk-message-streams/
      leader-plan-and-delegate.jsonl
      minion-completes-task.jsonl
```

Two vitest projects so the right environment runs against the right files:

- **node** — `server/**/*.test.ts`, `tests/architecture/**`, `tests/contracts/**`,
  and `src/**/*.test.ts` files marked `// @vitest-environment node`.
- **dom** — `src/**/*.test.tsx` and `src/**/*.test.ts` that use
  `@testing-library/react`.

---

## 5. Test scope rules

### Always test

- Reducers and other pure state machines.
- Schema validation paths (zod `.parse()` failures + successes).
- Parsers and converters (`sdkToDisplayMessages`, `extractStreamDelta`,
  `applyRenderMessage`).
- Layout math (`computeAutoLayout`, `findNonOverlappingPosition`).
- Path / security guards (`server/path-guard.ts`).
- Every public-facing MCP tool's input schema and broadcast effect.
- Every WS event type that crosses the network — round-trip parse it
  through the envelope.
- Architectural invariants we're committed to (see L4).

### Test, but lightly

- React components with substantial behaviour (SessionHost, RenderNode,
  EdgeRenderer, ApprovalBar). One test per observable user behaviour.
- Hooks that have non-trivial state machines (`useSocket` reconnect logic,
  `useCanvasHistory`).

### Don't test

- Purely visual styling (CSS, colours, spacing).
- Trivial pass-through props on a wrapper component.
- Third-party libraries (we trust react, ws, zod).
- The `claude-agent-sdk` itself. We mock its `query()` at the boundary.
- Auto-generated content like `id` strings (pin shape, not value).

### How to decide

If you're about to add a feature, ask:

> "If this breaks a year from now, who notices first?"

- *The user, mid-conversation, with no error message:* write a test.
- *Another developer, in CI, with a stack trace:* maybe write a test, maybe
  rely on TypeScript.
- *No one, because it's cosmetic:* don't write a test.

---

## 6. Development workflow

This is the working agreement for everyone (and every agent) working in
this repo.

### Day-to-day

1. **Before changing a module, run its tests.** Confirm they pass on `main`.
2. **Write or update tests in the same commit as the change.** Tests added
   "later" almost always slip.
3. **Watch mode while working.** `pnpm test` (no flags) keeps the suite
   running on file save. Sub-second feedback for the layers that matter.
4. **Before pushing, run `pnpm verify`** — a single command that runs
   `typecheck + test:run + build`, the same gates CI runs. If `verify`
   passes locally, CI will pass.
5. **Local pre-commit gate.** Install `prek` once per clone
   (`prek install`); the hook config is in `.pre-commit-config.yaml`.
   It runs `pnpm typecheck` and `pnpm test:run` on commits touching
   TS/JS files. Don't bypass with `--no-verify` — fix the cause.

### When refactoring

This is the situation we're about to live in. The rule is the test-first
arrow:

```
1. Write a test that captures the current behaviour you must preserve.
2. Confirm it passes on today's code.
3. Refactor.
4. The same test, unchanged, passes on the new code.
```

If step 4 requires changing the test, you've changed behaviour. Stop. Either
revert the change, or update the test consciously and explain in the PR.

The "snapshot replay" technique is the formalisation of this for SessionHost
(see `refactor-test-plan.md` Phase 1) — record what the screen looks like
today, reproduce it tomorrow.

### When fixing a bug

1. Write a test that triggers the bug. It must fail.
2. Fix the bug.
3. The test passes.
4. The test stays in the suite.

This is non-negotiable for any bug that escaped to a user. It is the
mechanism that prevents the same bug regressing twice.

### When adding a feature

1. Write the unit tests for the pure logic.
2. Write the contract test for any new WS event or MCP tool.
3. Write one component / interaction test that demonstrates the feature
   end-to-end *within* a single component (no full app).
4. Skip L5 unless this is the rare feature that justifies a full E2E.

### CI gate (per PR)

Required to pass before merge:

- `pnpm install --frozen-lockfile`
- `pnpm verify` (typecheck + test:run + build)

Each of the three legs catches a different class of regression:

- **`pnpm typecheck`** — `tsc -b --noEmit`, walks `tsconfig.app.json`
  with all strict flags (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`).
  Catches type-shape regressions.
- **`pnpm test:run`** — the full vitest suite, including the
  architecture-fitness tests under `tests/architecture/`. Catches
  behaviour regressions and drift past the documented allowlists.
- **`pnpm build`** — `tsc -b && vite build`. Confirms the production
  bundle compiles.

The CI workflow lives at `.github/workflows/ci.yml`; if you change
the verify command, change CI too.

**Scope note.** `pnpm typecheck` only walks the tsconfig project
references. Today that's `tsconfig.app.json` (covering `src/`) and
`tsconfig.node.json` (covering only `vite.config.ts`). The `server/`,
`tests/`, and `scripts/` trees are validated indirectly by vitest via
`tsx`, not by `tsc -b`. Broadening typecheck to those trees is tracked
as a separate scope expansion in CLAUDE.md "Known scope gaps".

### Coverage

Coverage is reported (`pnpm test:coverage`) and surfaced on each PR but does
not gate. The number we care about is the trend — if a PR removes coverage
for a module that had it, that's a flag worth a comment.

A target floor is fine to set in retrospect once we have a baseline. Picking
one before we've measured would be cargo-culting.

---

## 7. Conventions

### File naming

| Kind | Pattern |
|---|---|
| Unit (TS) | `<file>.test.ts` colocated |
| Unit (TSX) | `<file>.test.tsx` colocated |
| Contract | `tests/contracts/<area>.test.ts` |
| Architecture | `tests/architecture/<invariant>.test.ts` |
| Fixture | `tests/fixtures/<area>/<scenario>.<ext>` |

### Test structure

```ts
import { describe, it, expect } from "vitest";
import { canvasReducer } from "./canvas-state.ts";

describe("canvasReducer", () => {
  describe("ADD_NODE", () => {
    it("appends the node to the list", () => {
      const next = canvasReducer([], { type: "ADD_NODE", node: makeNode("n1") });
      expect(next).toHaveLength(1);
      expect(next[0]?.id).toBe("n1");
    });

    it("preserves existing nodes", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const next = canvasReducer(initial, { type: "ADD_NODE", node: makeNode("c") });
      expect(next.map((n) => n.id)).toEqual(["a", "b", "c"]);
    });
  });
});
```

- `describe` for the unit under test, nested `describe` for the action /
  variant, `it` for the behaviour.
- Test name reads as a sentence: `"appends the node to the list"`.
- Fixtures via small builder functions (`makeNode`, `makeEdge`) defined per
  test file or in `tests/fixtures/builders.ts`.

### Imports inside tests

The repo's tsconfig enables `verbatimModuleSyntax` and
`allowImportingTsExtensions`. Tests follow the same rules:

- `import type { … }` for types.
- `.ts` / `.tsx` extension on relative imports.

### Time and randomness

- Wrap `Date.now()` calls in code under test only when the test needs to
  assert on a specific timestamp. Use `vi.useFakeTimers()` + `vi.setSystemTime()`.
- For `crypto.randomUUID()`, prefer asserting on shape (`/^m-[a-f0-9-]+$/`)
  rather than value.

---

## 8. Anti-patterns to avoid

- **Testing the framework.** No tests that confirm React rendered an element.
  Test the behaviour the user sees.
- **Snapshot of an entire DOM tree.** Brittle, low-signal. Assert on the
  things that matter.
- **Mocking your own module.** If a module is hard to test without mocking
  itself, the design is wrong. Refactor first.
- **Over-coupled tests.** A test that breaks when you rename a private
  helper is testing implementation, not behaviour.
- **Skipping a test to land a PR.** If a test is wrong, fix it or delete
  it with justification. Skipped tests rot.
- **Adding a `setTimeout` to "wait for state."** Use `await waitFor(...)`
  from testing-library, or change the code to expose a promise.

---

## 9. Where this fits with the global standards

This document is a project-specific extension of the global CLAUDE.md
under "Code Quality → Testing." The global guidance applies in full:

> Test behavior, not implementation. Test edges and errors, not just the
> happy path. Mock boundaries, not logic. Verify tests catch failures.

What this document adds is the project-specific layering, the file
locations, and the fitness invariants that map to *this* codebase's
architecture review. Everything in the global standards still holds.

---

## 10. Maintenance

This document is owned by the team. Update it when:

- A new layer is added (e.g. when Playwright lands in Phase 4).
- A convention changes (e.g. test directory restructure).
- A new architectural invariant is added to the fitness suite.
- A tool is added or removed.

Drift between this doc and reality is itself a bug — flag it like any
other.
