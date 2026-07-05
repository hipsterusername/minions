# Testing Strategy — Minions Canvas

**Status:** Active. Supersedes the prior draft (2026-04-16) wholesale — see
`docs/archive/testing-gaps-2026-04-28-closed.md` for the audit findings
that drove the rewrite.
**Companion document (archived):** `docs/archive/testing-gaps-2026-04-28-closed.md`
— the punch list that came out of the audit. Every item is closed and
the doc is now historical record. This file is the working agreement.

---

## 1. Why this document was rewritten

A 2026-04-28 audit walked all 73 test files (~19,725 LoC) under a critical
TDD lens and surfaced four systemic problems that the prior strategy permitted:

1. **Tests of dependencies dressed as tests of us.** ~400 LoC of `zod` parse
   round-trips that exercise zod's own behaviour, not the project's. Fix:
   §5.4 schema rule.
2. **Snapshot blobs nobody reads.** Inline snapshots of pretty-printed
   message trees (~240 LoC each) that regenerate wholesale on any refactor.
   Fix: §5.6 snapshot rule.
3. **Architecture baselines that ratcheted upward.** `server/index.ts`
   tolerated ceiling went 1966 → 1969 → 2072 to absorb growth that was
   the very thing the test was supposed to gate. Fix: §6.1 one-way ratchet
   rule.
4. **Matchers that cannot fail.** `getBy*(...).toBeDefined()` / `.toBeTruthy()`
   epidemic — the query throws on miss; the matcher always passes. Fix:
   §5.5 React assertion rule + lint check (§6.3).

This rewrite doesn't add new layers. It tightens the rules inside the
existing layers so the suite tells the truth about what's covered.

---

## 2. The principle

> **A test earns its place only if a plausible regression in the code under
> test would make it fail.**

Apply this single principle to every test, old or new. If you can't describe
a regression that the test would catch — different from the regressions the
type checker, lint, or another test would catch — delete it.

Three corollaries:

- **Test what we author, not what we depend on.** Zod parses, JSON round-trips,
  Map lookups, `Array#filter`, React rendering an element — these all work
  because they're stable third-party (or language) primitives. Tests that
  re-verify them produce noise without signal.
- **Test the contract, not the implementation.** A refactor that preserves
  observable behaviour must not break tests. If it does, the test was wrong.
- **One test, one fact.** A test name should read as a falsifiable claim about
  behaviour. "renders without crashing" and "is a function" are not facts —
  they're tautologies dressed as tests.

---

## 3. Goals and non-goals

**Goals.**

1. Catch regressions in pure logic on every commit (reducers, parsers,
   schemas, layout math, MCP tool handlers, path guards, persistence).
2. Pin the contract between agents (MCP tool calls), the bus, and the
   client UI so the firehose of WS events always parses.
3. Catch architectural drift via fitness tests (file size, cross-tree
   imports, broadcast call sites, command-table coverage). Fail closed.
4. Make `pnpm test` a reflex — sub-second on a focused module, under a
   minute for the whole suite.
5. Verify the suite catches failures: per-quarter mutation-testing chore
   on at least one critical module (§6.4).

**Non-goals.**

- A coverage percentage gate. Coverage is a diagnostic.
- DOM snapshot tests. They drift, they're noisy, they pin ordering not
  meaning. The two snapshot harnesses in `tests/harness/` are tolerated
  only after they're rewritten to property assertions per §5.6.
- Full-browser end-to-end tests today. Deferred until Phase 4 lands
  persistence; until then a Playwright run would lock in the firehose.
- Mocking modules we own. We mock `ws`, `fs`, `better-sqlite3`,
  `child_process`, and the Anthropic SDK. We do not mock our reducers,
  our DSL, our tool factories, our bus, or our schemas.

---

## 4. The layers

A thin pyramid. Most value is in L1 and L2.

```
┌──────────────────────────────────────────────────────────────┐
│  L5 — End-to-end (Playwright; deferred until Phase 4 ships)  │
├──────────────────────────────────────────────────────────────┤
│  L4 — Architecture fitness (one-way ratchet; see §6.1)       │
├──────────────────────────────────────────────────────────────┤
│  L3 — Component / interaction (RTL + jsdom)                  │
├──────────────────────────────────────────────────────────────┤
│  L2 — Contract (WS envelope, MCP tool I/O, command table)    │
├──────────────────────────────────────────────────────────────┤
│  L1 — Unit (pure functions: reducers, DSL, parsers, layout)  │
└──────────────────────────────────────────────────────────────┘
```

### L1 — Unit

**Target.** Pure functions. No I/O, no React, no WS, no DB.

**Tool.** vitest, node env.

**Where.** Colocated. `src/foo.ts` → `src/foo.test.ts`.

**The minimum cases for any reducer / parser / schema / layout function:**

| Case | Why |
|---|---|
| Happy path | A regression that breaks the typical caller. |
| Empty input | Zero-element behaviour is a frequent edge. |
| Boundary input | First/last index, off-by-one, exactly-at-limit. |
| Malformed input | Reject with clear error; do not silently pass through. |
| Idempotency / inverse | If applicable (REMOVE-then-ADD, ADD-of-existing). |

**Banned patterns.**

- Asserting that a function does not mutate its input — that's a property of
  JS spread, not of the code. Test the result.
- `expect(typeof x).toBe("function")` / `expect(x).toBeDefined()` on the
  return value of a known-good factory — TS already enforces this.
- `MOCK_OF_SELF`: defining a callback in the test, passing it through, and
  asserting the callback's output reaches the assertion. The function is
  the identity — the test asserts nothing about your code.

### L2 — Contract

**Target.** The interface between subsystems: the WS envelope, the MCP

**Tool.** vitest, node env. Real schemas (no redefinition).

**Where.** `tests/contracts/<area>.test.ts` for cross-tree contracts.
Colocated for single-module contracts (e.g. `server/task-tools/assign-task.test.ts`).

**The contract test rule.** Every contract test exercises **both producer
and consumer** of the contract:

- ✗ Bad: parse a fixture through `wsEnvelopeSchema`. (Tests zod.)
- ✓ Good: drive the bus's `emit()` through the real producer code, capture
  the broadcast, parse it through the schema, and assert on the parsed
  shape. The test fails if the producer drifts away from the schema.

**Required contract tests today.**

| Surface | Producer | Consumer | Test |
|---|---|---|---|
| WS envelope | every `bus.emit*` site | client `useSocket` parser | `tests/contracts/ws-envelope.test.ts` (rewrite per §5.4) |
| Command table | `COMMAND_TABLE` | `tsc` (`satisfies Record<WsCommandType, Handler>`) | enforced at compile time; the runtime test is deletable (see gaps) |
| MCP task tools | `assign_task`, `complete_task`, etc. | leader prompt schema | `server/task-tools/<tool>.test.ts` — emit assertions |
| MCP minion tools | `report_step`, `report_done`, `report_fail` | minion prompt schema | colocated next to each tool |
| Render DSL | `render_set/append/patch/remove` | `applyRenderMessage` | one round-trip per component variant; not one zod-parse per variant |
| Persistence | `persist*` writers | `hydrate*` readers | one round-trip across `closePersistDb()/openPersistDb()` per session kind |

**Banned patterns.**

- Re-typing a TypeScript union as a runtime array (`EXPECTED_COMMANDS`
  duplicating `WsCommandType`). Use `satisfies` and let the compiler catch
  drift.
- Asserting on `pragma table_info` / `pragma index_list`. Schema shape is
  not a contract — round-tripping data through the schema is.
- Round-tripping a hand-built object that already matches the schema —
  the producer must be the real producer.

### L3 — Component / interaction

**Target.** React components whose behaviour is non-trivial: the
`ClaudeSessionNode` collapsible tool feed, `LeaderNode`'s task plan view,
`MinionNode`'s queue/active/log split, `KanbanBoard` interactions,
`AnnotationLayer` pointer events, `ApprovalBar` confirmation flow.

**Tool.** vitest + jsdom + `@testing-library/react`.

**Where.** Colocated. `src/components/Foo.tsx` → `src/components/Foo.test.tsx`.

**The component test rule.** Test what the user does, not what the JSX
contains:

- ✓ Good: simulate a click, assert the dispatched action's shape **and** the
  resulting visible text.
- ✗ Bad: render, query for an element, assert it exists. The query already
  throws on miss; the assertion adds nothing.
- ✗ Bad: assert on `style` strings, CSS variable names, or class names.
  These are presentation, not behaviour.

**Forbidden assertion shapes.**

| Pattern | Why banned | Replace with |
|---|---|---|
| `getBy*(...).toBeDefined()` | `getBy*` throws on miss; matcher cannot fail. | Drop the matcher; the query is the assertion. Or use `queryBy*` + a meaningful matcher. |
| `getBy*(...).toBeTruthy()` | Same as above. | Same. |
| `style.toMatch(/flex.../)` | Couples to inline-style implementation. | Test the user-visible behaviour the style produces. |
| `getAttribute("style").toContain("--token")` | Couples to CSS variables. | Test the rendered colour/layout outcome via what the user can see. |
| `expect.toMatchSnapshot()` | DOM trees drift on every CSS tweak. | Targeted text / attribute / role assertions. |
| Mocking the entire children subtree | Reduces test to wrapper-glue verification. | Render the real subtree. If it's too heavy, the wrapper has a design problem. |

**Mocking boundary.** `useSocket` is mocked to return a fake bus the test
drives. Anything below `useSocket` (reducers, parsers, render DSL apply) is
real. The Anthropic SDK is never reached from a component test.

### L4 — Architecture fitness

**Target.** Properties of the code as a whole: file size, cross-tree
imports, broadcast call sites, command-table coverage, banned assertion
patterns (new — see §6.3).

**Tool.** vitest with `fs` + regex; `ts-morph` only when AST is required.

**Where.** `tests/architecture/<invariant>.test.ts`.

**Rule.** Architecture fitness is a **one-way ratchet** — see §6.1.

### L5 — End-to-end

Deferred. Will land after persistence is stable. Until then, the WS replay
harness in `tests/harness/ws-replay.test.ts` (rewritten per §5.6) is the
nearest substitute.

---

## 5. Test scope rules — what to write, what to delete

This section codifies what changed in the audit. Each rule has a
`MUST` / `MUST NOT` clause and a tag the audit used; the gap document maps
each tag back to specific files.

### 5.1 The "regression-or-delete" rule

**MUST.** For every test, the author writes — in the PR or in a comment —
a one-sentence description of a regression that would make it fail.

**MUST NOT.** Land a test where the regression description reads "the
language stops working" or "zod stops working" or "React stops working".

Audit tag: `TAUTOLOGY` / `TYPE_AS_RUNTIME`.

### 5.2 The "no mock-of-self" rule

**MUST.** Mock at boundaries: `ws`, `fs`, `better-sqlite3`, `child_process`,
the Anthropic SDK, `crypto.randomUUID` when value matters.

**MUST NOT.** Mock a module written in this repo. If the seam you need
isn't a boundary, the design is wrong — refactor first.

**MUST NOT.** Pass an inline callback to a function under test, then assert
that the callback's output reaches the assertion. That tests the identity
function.

Audit tag: `MOCK_OF_SELF`.

### 5.3 The "test the result, not the spread" rule

**MUST.** Assert the value the function produces.

**MUST NOT.** Assert that the input array was not mutated. JS spread is
not under test. (One exception: a documented design that promises immutability
to callers may have ONE shared test asserting the contract; do not
repeat it per reducer.)

Audit tag: `IMPL_COUPLING` (mutation variant).

### 5.4 The "schema must round-trip through real producers" rule

**MUST.** A schema test drives a real producer (a tool factory, a bus emit
site, a persistence writer) and parses the captured output through the
schema.

**MUST NOT.** Hand-construct an object literal that already matches the
schema, parse it, and assert `.success === true`. That tests zod.

**MUST NOT.** Hand-construct an object missing a required field, parse it,
and assert `.success === false`. That tests `.optional()`.

When `safeParse` carries domain logic the codebase relies on (e.g.
test **that domain logic** — the formatted message structure, the error
path joining — not zod's pass/fail.

Audit tag: `SCHEMA_REDUNDANT`.

### 5.5 The "matcher must be falsifiable" rule

**MUST.** Every assertion must, on a hypothetical regression, fail. The
acceptance criterion: comment out the line under test, run the suite, and
the test must turn red.

**MUST NOT.** Combine a throwing query with a tautological matcher.
`getByText("X")` already throws if "X" is absent — appending `.toBeDefined()`
or `.toBeTruthy()` is noise. If the test means "X is visible", the query is
the assertion. If it means more (correct ordering, role, attribute), test
the more.

Audit tag: `TRIVIAL`.

### 5.6 The "snapshots are property assertions or they are deleted" rule

**MUST.** Replace inline snapshots of message trees, DOM, or pretty-printed
state with targeted property assertions: counts, ordered keys, specific
field values, ID shape. The replacement should be 5–20 lines, not 80–240.

**MUST NOT.** Capture an entire SDK message stream → DisplayMessage
conversion as `toMatchInlineSnapshot()`. Capture the **invariants**:
`messages.length === N`, `messages.map(m => m.role) === [...]`, the first
tool-use's `name`, the streaming-end marker's presence.

The two harness tests (`tests/harness/sdk-messages-snapshot.test.ts` and
`session-stream-snapshot.test.ts`) are tolerated only until rewritten;
they are **not** the template for new tests.

Audit tag: `SNAPSHOT_BLOB`.

### 5.7 The "no implementation pinning of static config" rule

**MUST.** Test the behaviour a config value produces.

**MUST NOT.** Assert that a constant equals a literal (`expect(X).toBe(42)`),
specific phase ID. The TypeScript compiler enforces shape; the value's
meaning is in the behaviour it drives.

Audit tag: `IMPL_COUPLING` / `ENCODES_CONSTANT`.

### 5.8 The "no log-spy as contract" rule

**MUST.** If a log line is the user-facing channel for an error, assert on
the channel the user sees (a UI message, an exception thrown to the
caller, a DB row).

**MUST NOT.** Spy on `console.warn` / `console.error` and assert on the
formatted string — log copy is not a contract.

Audit tag: `LOG_SPY`.

### 5.9 The "duplicates fail review" rule

**MUST.** When two tests exercise the same logical branch with different
incidentals (transport string, file extension, tag name), collapse them
to a single parameterised test.

**MUST NOT.** Write three near-identical describe blocks because three
variants of an enum exist.

Audit tag: `DUPLICATE`.

---

## 6. Architecture fitness in detail

### 6.1 The one-way ratchet rule (file size)

`tests/architecture/baselines.ts` records the maximum tolerated line
count for each oversize server file. The fitness test asserts no file
exceeds its ceiling. The ceiling is **one-way downward**:

- **Allowed:** ratchet a number DOWN when a refactor shrinks a file.
- **Forbidden:** ratchet a number UP. If a feature wants to land in an
  oversize file, it must land in a new file or shrink the file first.
  A PR that bumps a baseline up is a CI failure.

The history of this allowlist before this rule landed (per `git log`):

| File | Path | Outcome |
|---|---|---|
| `server/index.ts` | 1966 → 1969 → 2072 → drained | bumped twice for unrelated growth, then drained in Phase 5 |
| `server/worktree.ts` | 604 → 646 → drained | bumped, then split |
| `server/routes/projects.ts` | 596 → drained | held until Phase 5.3 |

The lesson: the allowlist functioned as a record of accepted regressions,
not as a gate. The new rule stops that.

**Enforcement.** A CI lint asserts the baselines file's diffs are
monotonic non-increasing for every key. PRs that bump a key up fail
without a manual override. The override is `// RATCHET_UP_OK: <reason>`
on the line being changed; reviewers treat it as a red flag.

### 6.2 Cross-tree imports

The allowlist is empty. It stays empty. A PR adding `from "../src/"` to
`server/` (or vice versa) fails the test. There is no allowlist back door.

### 6.3 Banned-assertion lint (new)

A new architecture test (`tests/architecture/no-banned-assertions.test.ts`)
greps the test tree for the patterns §5.5 forbids:

- `getBy[A-Z]\w+\([^)]*\)\.toBeDefined\(\)`
- `getBy[A-Z]\w+\([^)]*\)\.toBeTruthy\(\)`
- `getByTestId\([^)]*\)\.toBeDefined\(\)`
- `\.toMatchInlineSnapshot\(`  (warn — must come with §5.6 justification)
- `style.*toMatch\(.*flex|^.*toContain\("--`  (CSS coupling)

The original list of offenders lived in
`docs/archive/testing-gaps-2026-04-28-closed.md`; they were all fixed
before the lint was enabled. The lint is now the gate — any new offender
fails CI.

### 6.4 Mutation-testing chore (new)

Coverage tells you which lines a test executed. It does not tell you
whether the test would have caught a regression on those lines. Mutation
testing fills the gap: it perturbs the source (changes a `>` to `>=`,
flips a boolean, drops a branch) and asserts at least one test fails.

**Cadence.** Once per quarter, run `stryker run` (or equivalent for
vitest — at the time of writing the closest is `mutation-testing-elements`
+ a vitest runner adapter) against ONE critical module. The list rotates:

| Quarter | Module under mutation test |
|---|---|
| Q1 | `src/canvas-state.ts` + `src/graph-runtime.ts` |
| Q2 | `server/task-tools/*` |
| Q3 | `src/sdk-messages.ts` + `src/streaming.ts` |

The acceptance bar is mutation score ≥ 80% for the module. Surviving
mutants are tracked as gaps to fill in the next sprint, not as test
churn.

This is **not a CI gate**. It's a quarterly chore that surfaces blind
spots the human reviewer missed. The output drives the next sprint's
test work.

### 6.5 The "every WsCommandType has a handler" check

Already enforced by TypeScript via `COMMAND_TABLE: Record<WsCommandType,
CommandHandler>`. The runtime test in `tests/contracts/command-table.test.ts`
that hand-encodes `EXPECTED_COMMANDS` is deletable — its job is the
compiler's. Tracked in the gap doc.

---

## 7. Coverage requirements by surface

This is the production-file-to-test-file map. Every cell here is a contract:
a production file in column 1 has the test obligation in column 3, OR carries
a documented exception. The gap document tracks current state against this
matrix.

### 7.1 server/

| Surface | Test layer | Test file (target) | Notes |
|---|---|---|---|
| `server/bus.ts` | L2 | `server/bus.test.ts` | Producer-side emit captured + parsed; do not just round-trip schemas. |
| `server/db.ts` | L1 | `server/db.test.ts` (NEW) | Schema migration on a fresh tmpdir DB; guard against destructive migrations. |
| `server/project-store.ts` | L1 | `server/project-store.test.ts` (NEW) | Register / list / unregister round-trip; conflict on duplicate path. |
| `server/path-guard.ts` | L1 | exists | Trim duplicates per §5.9. |
| `server/render-tools.ts` | L2 | `server/render-tools.test.ts` (NEW) | Each `render_*` tool factory: invoke handler, assert on captured broadcast and updated state. |
| `server/minion-tools.ts` | L2 | `server/minion-tools.test.ts` (NEW) | Each tool: invoke handler, assert task/state mutations. |
| `server/task-tools/<tool>.ts` | L2 | colocated `<tool>.test.ts` | One per tool; cover happy path + error path + state-already-completed guard. Currently only `assign-task` covered. |
| `server/session-host.ts` | L1 | `server/session-host.test.ts` (NEW) | Lifecycle: start, abort, query loop, persistence callbacks. Mock SDK at boundary. |
| `server/session-host-config.ts` | L1 | colocated `.test.ts` (NEW) | Config build per role + permission mode. |
| `server/session-host-run.ts` | L1 | colocated `.test.ts` (NEW) | Run-loop transitions; abort race conditions. |
| `server/agents/<role>.ts` | L1 | colocated `.test.ts` (NEW) | Each agent factory's tool list, prompt, and registration. |
| `server/agents/registry.ts` | L1 | colocated `.test.ts` (NEW) | Lookup, register, list. |
| `server/commands/<cmd>.ts` | L2 | colocated `.test.ts` (NEW) | One per WS command. Currently only `attachment-sanitize` and `create-session` covered — 28 commands need tests. |
| `server/commands/index.ts` | L4 | drop the runtime test; `satisfies` is the gate | Per §6.5. |
| `server/routes/<area>.ts` | L2 | colocated `.test.ts` (NEW) | Real Express + supertest round-trips per route. |
| `server/worktree.ts` (barrel) | L1 | colocated `.test.ts` (NEW) | API stability — the public re-exports. |
| `server/worktree-create.ts` | L1 | colocated `.test.ts` (NEW) | Mock `child_process`; assert git invocation + error surface. |
| `server/worktree-diff.ts` | L1 | colocated `.test.ts` (NEW) | Same. |
| `server/worktree-merge.ts` | L1 | colocated `.test.ts` (NEW) | Same; merge-strategy branches. |
| `server/worktree-exec.ts` | L1 | colocated `.test.ts` (NEW) | Stdio routing, exit-code translation. |
| `server/mcp-server-store.ts` | L1 | exists | Parameterise transport duplicates per §5.9. |
| `server/multimodal-prompt.ts` | L1 | exists | Keep. |
| `server/skills.ts` | L1 | exists | Drop the empty-input trivial cases per §5.7. |
| `server/session-registry.ts` | L1 | exists | Drop the impl-coupled `map` reach-in per §5.2. |
| `server/session-repo.ts` | L1 | exists | Drop the `Object.keys` surface assertion per §5.7. |
| `server/session-persist.ts` | L1 | exists | Drop the `disablePersistence` no-op chain per §5.7. |

### 7.2 src/ — pure logic

| Surface | Layer | Test file | Notes |
|---|---|---|---|
| `src/canvas-state.ts` | L1 | exists | Drop the no-mutate cases per §5.3. |
| `src/canvas-utils.ts` | L1 | exists | Drop arithmetic-identity cases per §5.7. |
| `src/canvas-scale.ts` | L1 | NEW | Currently untested. |
| `src/graph.ts` | L1 | exists | Drop mock-of-self lifecycle tests per §5.2. |
| `src/graph-runtime.ts` | L1 | exists | Drop "no hidden ports" type-as-runtime cases per §5.7. |
| `src/auto-layout.ts` | L1 | exists | Drop trivial single-node cases per §5.9. |
| `src/sdk-messages.ts` | L1 | exists | Drop emoji-pinning tests per §5.7. |
| `src/streaming.ts` | L1 | exists | Collapse type-guard duplicates per §5.9. |
| `src/usage-aggregator.ts` | L1 | exists | Drop `shortModelLabel` regex pinning per §5.7. |
| `src/render-flatten.ts` | L1 | exists | Replace literal-format pinning with property assertions per §5.7. |
| `shared/render-dsl.ts` | L1 | exists (`shared/render-dsl.test.ts`) | Rewrite — see §7.4. |
| `src/sdk-messages.ts` | L1 | exists | Pinned. |
| `src/session-stream.ts` | L1 | exists | Drop reference-equality early-return tests per §5.7. |
| `src/mcp-paste-parser.ts` | L1 | exists | Drop `String#toLowerCase` test per §5.7. |
| `src/model-meta.ts` | L1 | exists | Rewrite — see §5.2. |
| `src/context-extraction.ts` | L1 | exists | Audit found this acceptable. |
| `src/kanban-types.ts` | L1 | exists | Trim trivials. |
| `src/use-kanban.ts` | L1 | exists (`use-kanban.dom.test.ts`) | Keep. |
| `src/use-socket.ts` | L1 | NEW | Reconnect logic, `sync_response` handling, message routing — currently untested. |
| `src/use-autosave.ts` | L1 | NEW | Debounce + flush — currently untested. |
| `src/use-canvas-keyboard.ts` | L1 | NEW | Keyboard mapping — currently untested. |
| `src/use-canvas-file-drop.ts` | L1 | NEW | File-drop dispatch — currently untested. |
| `src/use-theme.ts` | L1 | NEW | If non-trivial. |
| `src/wheel-detector.ts` | L1 | NEW | Trackpad vs mouse heuristic — currently untested. |
| `src/api.ts` | L1 | NEW | Fetch wrapper — currently untested. |
| `src/node-registry.ts` | L1 | NEW | Register / lookup / fallthrough — currently untested. |
| `src/skills/registry.ts` | L1 | NEW | Currently untested. |
| `src/skills/user-skills.ts` | L1 | NEW | Currently untested. |
| `src/skills/built-in/index.ts` | L1 | exists | Drop idempotency-of-set test per §5.2. |

### 7.3 src/ — React components

| Surface | Layer | Test file | Notes |
|---|---|---|---|
| `src/Canvas.tsx` | L3 | NEW (the file is too big to grow without tests) | Keyboard nav, drag, edge add/remove. |
| `src/CanvasNode.tsx` | L3 | NEW | Drag, select, port socket. |
| `src/EdgeRenderer.tsx` | L3 | NEW | Port-anchor math at scale; not visual. |
| `src/SessionPanel.tsx` | L3 | exists | Drop `getByText.toBeDefined()` patterns per §5.5. |
| `src/UsagePopover.tsx` | L3 | exists — DELETE current and replace | Every test in current file violates §5.5. Rewrite minimally or drop. |
| `src/BottomRightDock.tsx` | L3 | exists | Trim per §5.5. |
| `src/KanbanBoard.tsx` | L3 | exists | Audit found this acceptable. |
| `src/components/AnnotationLayer.tsx` | L3 | exists | Keep. |
| `src/components/AnnotationList.tsx` | L3 | exists | Keep. |
| `src/components/AnnotationSidebar.tsx` | L3 | exists | Drop CSS-flex assertions per §5.5. |
| `src/components/markup-palette.tsx` | L3 | NEW | Currently untested. |
| `src/nodes/ClaudeSessionNode.tsx` | L3 | exists | Audit found this acceptable. |
| `src/nodes/LeaderNode.tsx` | L3 | exists | Audit found this acceptable. |
| `src/nodes/MinionNode.tsx` | L3 | exists | Keep. |
| `src/nodes/MarkdownNode.tsx` | L3 | exists | Keep. |
| `src/nodes/ImageNode.tsx` | L3 | exists | Drop the DOM-API-counter and CSS-token tests per §5.5. |

### 7.4 shared/ — cross-tree contracts

| Surface | Layer | Test file | Notes |
|---|---|---|---|
| `shared/ws-envelope.ts` | L2 | exists — REWRITE | Replace zod-pass/fail tests with bus-emit-then-parse round-trips per §5.4. |
| `shared/render-dsl.ts` | L2 | exists — REWRITE | Drop schema-identity cases (~150 LoC); keep one round-trip per component variant via a real `applyRenderMessage` consumer. |

### 7.5 tests/architecture/

| File | Status |
|---|---|
| `file-size.test.ts` | Keep + add the "monotonic non-increasing baselines" lint per §6.1. |
| `no-cross-tree-imports.test.ts` | Drop the empty-allowlist scaffolding per §5.7 / §5.9. |
| `no-direct-broadcast.test.ts` | Drop the trivial "bus.ts has at least one broadcast" sanity per §5.7. |
| `no-direct-ws-send.test.ts` | Keep. |
| `no-banned-assertions.test.ts` | NEW — see §6.3. |

### 7.6 tests/contracts/

| File | Status |
|---|---|
| `command-table.test.ts` | DELETE — replace with `satisfies` in `commands/index.ts` per §6.5. |
| `image-node.test.ts` | DELETE — re-reads literal fields from the same module that registered them. |
| `ws-envelope.test.ts` | Rewrite per §5.4. |

### 7.7 tests/harness/

| File | Status |
|---|---|
| `sdk-messages-snapshot.test.ts` | REWRITE — replace ~240 LoC inline snapshot with property assertions per §5.6. |
| `session-stream-snapshot.test.ts` | REWRITE — same. The duplicate vs `sdk-messages-snapshot` collapses. |
| `ws-replay.test.ts` | Keep the replay harness; drop the trivial fake-self-tests per §5.7. |

---

## 8. Tooling

| Concern | Tool | Notes |
|---|---|---|
| Test runner | **vitest** | Two projects: `node` for `server/**`, `tests/**`, `shared/**`, and `src/**.test.ts` marked `// @vitest-environment node`; `dom` for `src/**.test.tsx` and `src/**.dom.test.ts`. |
| DOM | **jsdom** | Component layer only. |
| Component queries | **@testing-library/react** + **@testing-library/jest-dom** | `getByRole` / `getByText`. `getByTestId` only when role is unavailable. |
| Coverage | **@vitest/coverage-v8** | `pnpm test:coverage`. Reported, never gated. |
| Mutation testing | **stryker-mutator** with `vitest` runner | Quarterly chore, single module at a time. |
| Lint | **oxlint** | Per the global standard. Custom rules for §6.3 banned assertions in tests/. |
| Schema | **zod** | Production schemas; tests do not redefine them. |
| Mocks | **vitest `vi.fn`, `vi.mock`** | Boundary modules only — see §5.2. |

We do not add jest, mocha, sinon, msw, enzyme, chai, ts-jest, or storyshots.

---

## 9. Project layout

```
src/
  graph.ts
  graph.test.ts                       ← colocated unit tests (L1)
  components/
    AnnotationLayer.tsx
    AnnotationLayer.test.tsx          ← colocated component tests (L3)
  nodes/
    LeaderNode.tsx
    LeaderNode.test.tsx
server/
  bus.ts
  bus.test.ts
  task-tools/
    assign-task.ts
    assign-task.test.ts
  commands/
    create-session.ts
    create-session.test.ts
shared/
  ws-envelope.ts
  ws-envelope.test.ts                 ← cross-tree contract (L2)
tests/
  architecture/
    baselines.ts
    file-size.test.ts                 ← L4
    no-banned-assertions.test.ts      ← L4 (new)
  contracts/
    ws-envelope.test.ts
  harness/
    ws-replay.test.ts                 ← replay harness for L3 by fixture
    sdk-messages-snapshot.test.ts     ← (rewrite: property assertions, not blobs)
    session-stream-snapshot.test.ts   ← (rewrite: same)
  fixtures/
    sdk-message-streams/
      leader-plan-and-delegate.jsonl
      minion-completes-task.jsonl
    builders.ts                       ← shared `makeNode`, `makeEdge`, `makeMessage`
```

---

## 10. Workflow

### Day-to-day

1. **`pnpm test`** (watch). Sub-second per-module reruns on save.
2. **Behaviour change → tests in the same commit.** No "follow-up PR for tests".
3. **`pnpm verify`** before push. Mirrors CI exactly.
4. **`prek install`** once per clone. Hook runs `pnpm typecheck && pnpm test:run`
   on commits touching TS/JS files.

### Refactor

The test-first arrow:

```
1. Write a test that captures the current behaviour you must preserve.
2. Confirm it passes on today's code.
3. Refactor.
4. The same test, unchanged, passes on the new code.
```

If step 4 forces you to change the test, you've changed behaviour. Stop;
revert or call it out in the PR with reasoning.

### Bug fix

1. Write a test that triggers the bug. **It must fail.**
2. Fix the bug. The test passes.
3. The test stays.

Bug-regression tests are non-negotiable.

### New feature

1. Unit tests for pure logic (L1).
2. Contract test for any new WS event, MCP tool, or persistence shape (L2).
3. One component test that demonstrates the user-visible behaviour (L3).
4. Skip L5 unless the feature genuinely cannot be verified at L1–L3.

### CI gate

Required to pass before merge:

- `pnpm install --frozen-lockfile`
- `pnpm verify` (typecheck + test:run + build)
- The new fitness tests (§6.3) gate after the gap remediation lands.

### Coverage

Reported, not gated. The number we care about is the **trend**: a PR that
reduces coverage on a module that had it is a flag worth a comment in
review. A floor will be set once we have a baseline that the gap document
brings under control.

### Mutation testing

Quarterly chore. Output drives the next sprint's test work, not the
current PR.

---

## 11. Conventions

### File naming

| Kind | Pattern |
|---|---|
| Unit (TS) | `<file>.test.ts` colocated |
| Unit (TSX) | `<file>.test.tsx` colocated |
| Component (DOM-required) | `<file>.test.tsx` colocated |
| Hook (DOM-required) | `<file>.dom.test.ts` colocated |
| Contract | `tests/contracts/<area>.test.ts` |
| Architecture | `tests/architecture/<invariant>.test.ts` |
| Harness | `tests/harness/<purpose>.test.ts` |
| Fixture | `tests/fixtures/<area>/<scenario>.<ext>` |

### Test structure

```ts
import { describe, it, expect } from "vitest";
import { canvasReducer } from "./canvas-state.ts";
import { makeNode } from "../tests/fixtures/builders.ts";

describe("canvasReducer", () => {
  describe("ADD_NODE", () => {
    it("appends the node to the end of the list", () => {
      const next = canvasReducer([], { type: "ADD_NODE", node: makeNode("n1") });
      expect(next.map((n) => n.id)).toEqual(["n1"]);
    });

    it("preserves order when adding to a non-empty list", () => {
      const initial = [makeNode("a"), makeNode("b")];
      const next = canvasReducer(initial, { type: "ADD_NODE", node: makeNode("c") });
      expect(next.map((n) => n.id)).toEqual(["a", "b", "c"]);
    });
  });
});
```

- Test name reads as a falsifiable sentence about behaviour.
- One claim per `it`.
- Fixtures via builder functions in `tests/fixtures/builders.ts` —
  not freshly invented in every test file.

### Imports inside tests

`verbatimModuleSyntax` and `allowImportingTsExtensions` are on. Tests follow:

- `import type { ... }` for types.
- `.ts` / `.tsx` extension on every relative import.

### Time and randomness

- `vi.useFakeTimers()` + `vi.setSystemTime()` when a timestamp must be
  asserted on. Otherwise leave time alone.
- `crypto.randomUUID()`: assert on shape (`/^m-[a-f0-9-]+$/`), not value.

---

## 12. Anti-patterns at a glance

| Pattern | Tag | Rule |
|---|---|---|
| `expect(typeof x).toBe("function")` | TAUTOLOGY | §5.1 |
| Inline callback in test → assertion of callback's own output | MOCK_OF_SELF | §5.2 |
| Asserting "function does not mutate input" | IMPL_COUPLING | §5.3 |
| `schema.parse(literal).success === true` | SCHEMA_REDUNDANT | §5.4 |
| `getBy*(...).toBeDefined()` / `.toBeTruthy()` | TRIVIAL | §5.5 |
| `expect.toMatchSnapshot()` of DOM tree or message stream | SNAPSHOT_BLOB | §5.6 |
| `style.toMatch(/flex.../)` / `style.toContain("--token")` | IMPL_COUPLING | §5.5 |
| `expect(CONSTANT).toBe(literal)` | ENCODES_CONSTANT | §5.7 |
| `console.warn` spy + content assertion | LOG_SPY | §5.8 |
| Three describe blocks differing only by a variant string | DUPLICATE | §5.9 |
| Bumping a baseline UP | RATCHET | §6.1 |
| Hand-encoding a TS union as a runtime array | TYPE_AS_RUNTIME | §6.5 |

---

## 13. Where this fits

This document is a project-specific extension of the global standards in
`~/.claude/CLAUDE.md` ("Code Quality → Testing"). The global guidance still
applies in full:

> Test behavior, not implementation. Test edges and errors, not just the
> happy path. Mock boundaries, not logic. Verify tests catch failures.

The project additions are:

- The audit-driven anti-pattern list (§5).
- The one-way ratchet for architecture baselines (§6.1).
- The banned-assertion lint (§6.3).
- The mutation-testing rotation (§6.4).
- The full coverage matrix (§7).

---

## 14. Maintenance

Update this document when:

- A new layer is added (Playwright in Phase 4).
- A new anti-pattern is identified in a future audit.
- A new architectural invariant is added.
- The mutation-testing rotation completes a cycle (record findings).

Drift between this document and reality is itself a bug — flag it in
the PR that introduces it.

When the next audit runs, the working pattern is: produce a new
`docs/testing-gaps-YYYY-MM-DD.md` punch list, work through it, and once
every entry is closed, archive it under `docs/archive/` with a
`-closed.md` suffix. The 2026-04-28 cycle is preserved at
`docs/archive/testing-gaps-2026-04-28-closed.md` as the canonical
example.
