# Refactor Test Plan — Phase-by-Phase

**Companion to:** [`testing-strategy.md`](./testing-strategy.md) (the working
agreement) and [`architecture-review-2026-04-16.md`](./architecture-review-2026-04-16.md)
(the diagnosis the refactor responds to).

This document maps the five refactor phases to the specific tests that
must exist **before**, **during**, and **after** each phase. The shape is
the same for every phase:

```
┌─ Pre-flight ──────── Tests that must already pass on `main` before the
│                      phase begins. These are the regression net.
├─ In-flight ───────── Tests written alongside the new code that target
│                      the new API.
├─ Post-flight ─────── Tests that prove the migration was complete and
│                      the old shape can be removed.
└─ Exit criteria ───── The objective signal that the phase is done.
```

A phase is not done until **every test in all three rows is green and
the exit criteria are satisfied**.

---

## Phase 0 — Guardrails (1–2 days)

The architecture review names four guardrails to set up first. We
encode each as an automated test.

### Pre-flight

The baseline pure-module suite (the modules that aren't being moved by
the refactor) must already be green on `main`:

| Suite | File |
|---|---|
| canvas reducer | `src/canvas-state.test.ts` |
| render DSL | `src/render-dsl.test.ts` |
| graph contracts | `src/graph.test.ts` |
| graph runtime | `src/graph-runtime.test.ts` |
| sdk → display messages | `src/sdk-messages.test.ts` |
| streaming deltas | `src/streaming.test.ts` |
| canvas utils | `src/canvas-utils.test.ts` |
| auto-layout | `src/auto-layout.test.ts` |
| path guard | `server/path-guard.test.ts` |

These exist as part of the "baseline pure-module tests" task in the
initial setup PR.

### In-flight

Add the four architecture fitness tests:

1. **`tests/architecture/file-size.test.ts`**
   - Walks `server/*.ts` (excluding tests).
   - Fails on any file > 400 lines that is *not* in the
     `KNOWN_OVERSIZE` allowlist.
   - Fails if any file in `KNOWN_OVERSIZE` *grows*.
   - The allowlist is the published debt: `index.ts` (1966 today),
     `worktree.ts` (604 — already cohesive, kept for completeness),
     `task-tools.ts` (~620). Each entry must shrink by Phase 5.

2. **`tests/architecture/no-cross-tree-imports.test.ts`**
   - Greps `server/**/*.ts` for `from "../src/`. The single allowed
     match today is `server/index.ts` importing
     `../src/prompts/minion-system.ts`. The test asserts the count
     equals the documented allowlist.
   - Greps `src/**/*.ts(x)` for `from "../server/`. Must be zero.

3. **`tests/architecture/no-direct-broadcast.test.ts`**
   - Greps the source tree for `broadcast(wss,`.
   - During Phase 0 → 1, the test is "this number does not increase"
     (snapshot the count, fail on growth).
   - From Phase 2 onward (after `server/bus.ts` lands), the test
     becomes "must equal zero outside `server/bus.ts`."

4. **`tests/architecture/no-stringly-typed-roles.test.ts`** *(staged for Phase 3)*
   - `role: "leader" | "minion" | "default"` literal type usage outside
     the agent registry. Initially a snapshot count; switches to "must
     equal zero" when Phase 3 lands the registry.

### Post-flight

- The CI workflow runs `pnpm test --run` and the architecture tests fail
  the build on a regression.
- The `docs/architecture.md` (or this file) documents target module
  boundaries — already done.

### Exit criteria

- All four fitness tests run in CI.
- All baseline pure-module tests pass.
- Allowlists are checked into the repo and reviewed in the PR.

---

## Phase 1 — `SessionHost` primitive (1 week)

**Goal of the phase.** Extract the chat infrastructure shared by
`LeaderNode` (3553 lines), `MinionNode` (1109 lines), and
`ClaudeSessionNode` (1571 lines) into one `SessionHost` component. The
three nodes shrink to thin wrappers that pass slots.

**The risk.** This is the biggest change in the project — 3000+ lines
collapse. Any regression in how a chat renders silently corrupts the
core UX.

**The mitigation.** Build a **WebSocket replay snapshot harness** *before
touching the node files*. Once it can re-render today's `LeaderNode`
faithfully from a recorded stream, we have the golden snapshot for the
new SessionHost.

### Pre-flight

1. **WS replay harness** — `tests/fixtures/sdk-message-streams/` and
   `tests/harness/ws-replay.ts`.
   - Capture mechanism: a dev-only "record" toggle in the WS layer that
     writes every inbound message for a sessionKey to JSONL.
   - Replay: load JSONL, feed each message through a mocked `useSocket`
     in the order recorded, render the component, snapshot the
     accessibility tree (not the full DOM) of the message feed.
   - Fixtures recorded for these scenarios:
     - `leader-plan-and-delegate.jsonl` — leader plans, delegates two
       tasks, both minions complete, leader requests approval.
     - `leader-thinking-and-text.jsonl` — assistant message with
       thinking + text + tool_use blocks split correctly.
     - `leader-stream-then-final.jsonl` — streamed deltas followed by
       final assistant message; no duplication.
     - `minion-completes-task.jsonl` — minion receives task, reports
       step, reports done.
     - `claude-session-basic.jsonl` — generic session with no MCP tools.

2. **Snapshot the current rendering** of LeaderNode, MinionNode, and
   ClaudeSessionNode against each fixture. Files:
   - `src/nodes/__snapshots__/LeaderNode-replay.snap`
   - `src/nodes/__snapshots__/MinionNode-replay.snap`
   - `src/nodes/__snapshots__/ClaudeSessionNode-replay.snap`

   These snapshots are the *behavioural contract* — they are the only
   snapshots in the repo that we treat as authoritative.

### In-flight

3. **`src/components/SessionHost.test.tsx`** — TDD the new component:
   - Renders the message feed for each fixture.
   - Calls `onSend` with the right payload when the input is submitted.
   - Renders header / footer / side-panel slot props.
   - Auto-scrolls when a new message arrives and the user is at bottom.
   - Stops auto-scrolling when the user scrolls up.
   - Deduplicates messages by `sdkUuid`.
   - Renders streaming deltas progressively then collapses into the
     final assistant message without flashing.

4. **Wrappers tests** — once the wrappers exist:
   - `src/nodes/LeaderNode.test.tsx` — replays the same fixtures, asserts
     the snapshots from step 2 are still produced.
   - Same for `MinionNode.test.tsx` and `ClaudeSessionNode.test.tsx`.

5. **Slot tests.** A test per slot component:
   - `TaskBoard.test.tsx` — renders the task plan, transitions on
     `task_plan_update` events.
   - `WorktreePanel.test.tsx` — renders branch + status.
   - `ApprovalBar.test.tsx` — renders approval state, fires merge /
     discard handlers.
   - `MinionStatus.test.tsx` — renders status pill + progress.

### Post-flight

6. **Line-count check.** Add to `tests/architecture/file-size.test.ts`
   the assertion that combined `LeaderNode + MinionNode + ClaudeSessionNode`
   line count has shrunk by at least 2500. Failure means the extraction
   was incomplete.

7. **Audit `ClaudeSessionNode`.** If no remaining users, delete the
   file in the same PR (per global guidance: "Replace, don't deprecate").
   Add a removal test that asserts the file does not exist.

### Exit criteria

- All replay-snapshot tests green for all five fixtures.
- All slot tests green.
- The combined size of the three node files is below 600 lines (down
  from ~6200).
- Coverage report shows SessionHost ≥ 80 %.

---

## Phase 2 — Typed bus + shared schemas (1 week)

**Goal of the phase.** Replace the WS firehose with a typed envelope
(`{topic, protocol, payload}`) and topic-based subscription on the
client. Deduplicate the render DSL between `server/render-tools.ts` and
`src/render-dsl.ts` into `shared/render-dsl.ts`.

### Pre-flight

1. **`tests/contracts/render-dsl-parity.test.ts`** — checks that the
   server's component schema accepts every example from the client's
   union, and rejects every shape the client union rejects.
   - Failure today is a known issue and the test will *fail on `main`*
     until the dedup lands. We accept this — it's the test telling us
     to do the work.

2. **`tests/contracts/ws-broadcasts-snapshot.test.ts`** — capture every
   broadcast the server emits today by replaying the same five fixtures
   from Phase 1, but on the *server* side. Output: a JSON file of
   `{type, fields[]}` shapes per event type. This is the "what the wire
   looks like today" baseline.

### In-flight

3. **`shared/render-dsl.ts`** is created. The contract test from
   step 1 is rewritten to import from the shared module and use it on
   both sides:
   ```ts
   // tests/contracts/render-dsl-parity.test.ts
   import { renderComponentSchema } from "../../shared/render-dsl.ts";
   import type { RenderComponent } from "../../shared/render-dsl.ts";
   // assert client union and server schema are the same value.
   ```

4. **`shared/ws-envelope.ts`** is created with a zod schema for
   `WsEnvelope`. Add tests:
   - `tests/contracts/ws-envelope.test.ts` — every example from the
     server's broadcasts (snapshot from step 2) must parse against the
     envelope.
   - Topic format is one of `session:<key>` | `project:<id>` | `global`.

5. **`server/bus.ts`** is created. Tests:
   - `server/bus.test.ts` — `emit` reaches all clients subscribed to
     the topic and *no* clients subscribed to a different topic.
   - `emitToSession(key, event)` builds the right envelope.
   - Backpressure: a slow client doesn't block the bus.

6. **Client subscription.** Tests:
   - `src/use-socket.test.ts` (extended) — `subscribe(topic, handler)`
     receives only matching envelopes; unsubscribing removes the
     handler; reconnect re-establishes subscriptions.

7. **Migration tests.** For each broadcast site that has been migrated
   to the bus:
   - Tests assert the bus emit was called with the right envelope.
   - Tests assert no direct `wss.clients.send` calls remain (covered
     by the architecture test from Phase 0, but doubled here).

### Post-flight

8. **Architecture test flips.** `tests/architecture/no-direct-broadcast.test.ts`
   changes from "count does not increase" to "must equal zero." This
   is the wall — once flipped, no PR can re-introduce a direct broadcast.

9. **Render DSL parity test deletion.** Once both sides import from the
   shared module, the parity check is meaningless — delete it and replace
   with a single schema test in `shared/render-dsl.test.ts`.

### Exit criteria

- All client subscriptions go through `subscribe(topic, …)`. None left
  using the legacy "every message" listener (architecture test enforces).
- Both sides import the render DSL from `shared/`.
- The `KNOWN_SERVER_MESSAGE_TYPES` hand-maintained list in
  `src/use-socket.ts` is removed (its job is done by the envelope).

---

## Phase 3 — Agent type registry (1 week)

**Goal of the phase.** Replace `role: "leader" | "minion" | "default"`
with a server-side `AgentType` registry that owns the prompt, MCP
tools, worktree policy, and data sanitization for each role. Move
prompts out of `src/prompts/` into `server/agents/<role>/prompt.ts`.

### Pre-flight

1. **MCP tool factory tests** — without these, we can't refactor the
   factories with confidence.
   - `server/task-tools.test.ts` — call each tool's handler with valid
     args, assert state transitions and broadcast envelopes.
   - `server/render-tools.test.ts` — `set / patch / append / remove`,
     assert local state and broadcast.
   - `server/minion-tools.test.ts` — `report_step / report_done /
     report_fail`, assert broadcasts.

2. **Lifecycle tests for `runSession`** — extract the parts of
   `runSession` that branch on role into testable functions, then test
   each branch:
   - Worktree created only for leader (when isolation is on).
   - System prompt selected by role.
   - MCP servers wired by role.

### In-flight

3. **`server/agents/types.ts`** + `server/agents/registry.ts` — tests:
   - `registerAgentType` rejects duplicate ids.
   - `getAgentType` returns the registered bundle.
   - `buildSystemPrompt(agentType, ctx)` composes the behavioral core
     with the auto-generated capability manifest from the Zod schemas.

4. **Each agent bundle.** `server/agents/leader/agent.test.ts`,
   `server/agents/minion/agent.test.ts`, `server/agents/default/agent.test.ts`:
   - Bundle declares the right id, allowed tools, worktree policy.
   - System prompt builder produces the expected sections (header,
     behaviour, tools, render DSL appendix).
   - Tools section in the prompt is *generated* from the tool factory's
     Zod schemas — no hand-written copy. Test: change a tool's
     description, the prompt updates.

5. **`runSession` reduction.** A focused test that the new dispatcher
   is ≤80 lines and consults the registry:
   - `tests/architecture/run-session-dispatch.test.ts` — file-size
     assertion plus an AST check (with `ts-morph`) that the function
     contains zero `role === "..."` literal comparisons.

6. **Prompt move.** `tests/architecture/no-cross-tree-imports.test.ts`
   updates: the previously-allowlisted `MINION_SYSTEM_PROMPT` import is
   removed; the test now asserts zero cross-tree imports.

### Post-flight

7. **Adding a new agent type takes < 50 lines.** Demonstrate by adding
   a `card-creation` agent type behind a feature flag and writing the
   test file for its bundle. The PR diff is the proof.

### Exit criteria

- `server/agents/registry.ts` is the single source of truth for agent
  metadata.
- No `src/prompts/*` imports from `server/`.
- The "stringly-typed roles" architecture test flips to zero.
- `runSession` is ≤ 80 lines.

---

## Phase 4 — Graph-as-bus + persisted sessions (1–2 weeks)

**Goal of the phase.** Make the visual graph the actual data routing
layer. Persist task / render / approval / message state in SQLite so
sessions survive server restarts.

This is the highest-risk phase. We split it into four sub-PRs, each
with its own test set.

### Sub-PR 4.1 — Route task/status/result through `dispatchMessage`

> **Note.** The speculative `status-in` / `result-in` ports on the leader
> (and paired `status-out` / `result-out` on the minion) were removed as
> dead code — they were declared in the contract but nothing emitted,
> received, or rendered them. When this sub-PR lands, re-add those ports
> to `LEADER_CONTRACT` / `MINION_CONTRACT` alongside the new dispatch
> wiring; don't reintroduce them ahead of the wiring.

#### Pre-flight

1. **`src/graph-runtime.test.ts`** (extended) — `dispatchMessage`
   delivers to multiple subscribers, deduplicates per edge, ignores
   messages with no matching edge.

#### In-flight

2. **Routing migration tests.** For each protocol now flowing through
   edges (was previously a broadcast):
   - `task-assignment` — leader emits, minion receives via the edge.
   - `task-status` — minion emits, leader receives.
   - `task-result` — minion emits, leader receives.

   Test shape: spin up a fake leader-and-minion pair, exercise the
   message, assert delivery.

3. **Visual / data parity.** A test that *every* active message edge
   is also a non-hidden visible edge in the graph document.

#### Exit criteria for 4.1

- Leader `status-in` / `result-in` and minion `status-out` / `result-out`
  ports are re-added to `src/graph.ts` and wired through
  `dispatchMessage`.
- Every routed protocol has a delivery test.

### Sub-PR 4.2 — Generalised port lifecycle

#### Pre-flight

4. **Existing context-port lock test** continues to pass.

#### In-flight

5. **`src/graph.test.ts`** — `PortDefinition.lifecycle` is consulted
   in `createEdge`. New tests:
   - A port with `lifecycle: () => "locked"` rejects connections.
   - Lifecycle is given the target node data and can decide based on it.
   - The pre-existing `canAcceptContextConnection` is reimplemented as
     a lifecycle on the leader's `context-in` port; old tests still pass.

#### Exit criteria for 4.2

- `canAcceptContextConnection` removed; behaviour preserved by the
  lifecycle on the port definition.

### Sub-PR 4.3 — Node-type declarative extensions

#### Pre-flight

6. **Canvas behaviour tests** for things currently hardcoded in
   `Canvas.tsx`:
   - Leader drag bundles its minions: write a test on the current
     code so the new registry-driven implementation has a target.
   - Context-group reflow on resize.
   - Render-node positioning relative to its leader.
   - Sanitize-on-load: status fields reset.

   These tests run against the *behaviour* through a small canvas
   harness, not against the line count.

#### In-flight

7. **`src/types.test.ts`** — new `NodeTypeDefinition` fields
   (`ownsChildrenOfType`, `providesContext`, `layoutPolicy`,
   `sanitizeOnLoad`) are honoured by the canvas controller.

8. **Canvas controller tests.** Once `useCanvasGraphController` exists:
   - Receiving `minion_spawned` (or now: a `task-assignment` envelope)
     creates a child node and an edge.
   - Receiving `render_update` mutates the linked render node.
   - The same behaviours as the pre-flight tests, now driven by the
     registry instead of by hardcoded `if (type === "leader")`.

#### Exit criteria for 4.3

- The 61 hardcoded `type === "<literal>"` checks are reduced to a
  single allowlist in the registry tests (we expect a small handful to
  remain in the registry definitions themselves).
- All canvas-behaviour tests pass against the new controller.

### Sub-PR 4.4 — Persisted session state

#### Pre-flight

9. **`server/project-store.test.ts`** for what's already persisted:
   - Round-trip a project, its nodes, transform.
   - Cascade delete works.

#### In-flight

10. **New persistence tables / repositories.** Tests:
    - `task-state.repo.test.ts` — round-trip `TaskManagerState` (tasks
      Map, pendingWait, approval).
    - `render-state.repo.test.ts` — round-trip the dashboard.
    - `event-log.repo.test.ts` — append-only event log per session;
      replaying reconstructs the in-memory state.

11. **Restart tests.** A "boot, tear down, boot again" scenario:
    - Start a server, create a leader, plan a task, delegate to a
      minion. Stop the server.
    - Start the server again with the same SQLite. The session is
      retrievable; task state is intact; the canvas hydrates correctly.

#### Exit criteria for 4.4

- A server restart preserves task plan, render dashboard, approval
  state, and message log.
- Event log replay reconstructs identical in-memory state for a fixture
  session (round-trip property).

### Phase 4 exit criteria (overall)

- All four sub-PRs merged with their test sets green.
- Coverage on `server/agents/`, `server/persistence/`, and the new
  controllers ≥ 70 %.

---

## Phase 5 — Canvas / server decomposition (1 week)

**Goal of the phase.** Split `Canvas.tsx` (3125 lines) into a small
viewport component plus controllers/hooks. Split `server/index.ts`
(1966 lines) into a thin entry plus per-command handlers.

### Pre-flight

1. **The canvas-behaviour tests from Phase 4 sub-PR 4.3** must already
   be green. They are the regression net for the split.

2. **Server command tests** — for each WS command currently handled by
   `server/index.ts:handleCommand`, write one test that exercises the
   command directly through a small dispatcher harness (just the
   function, no WS):
   - `create_session`, `send_prompt`, `stop_session`, `resume_session`,
     `merge_worktree`, `discard_worktree`, `force_merge_worktree`,
     `theirs_merge_worktree`, `request_approval`, `approve_changes`,
     `wait_continue`.

   These look like integration tests, but they exercise pure handlers
   given a fake `Session` and a fake `bus`. No real WS, no SDK.

### In-flight

3. **`Canvas.tsx` extraction tests.**
   - `useCanvasGraphController.test.ts` — already exists from Phase 4.
   - `useCanvasLayout.test.ts` — children-reflow policy from the
     registry.
   - `Canvas.test.tsx` — viewport pan/zoom, marquee selection, drag.

4. **`server/handlers/<command>.test.ts`** — one file per command,
   covering the test cases from step 2 above against the new
   per-command file.

### Post-flight

5. **Architecture file-size assertion** for `Canvas.tsx` (≤ 600 lines)
   and `server/index.ts` (≤ 200 lines). Allowlist entries removed.

6. **`ClaudeSessionNode` removal verification.** If still present from
   Phase 1, delete and add the no-file assertion.

### Exit criteria

- All architecture file-size targets met.
- Per-command handler tests cover every WS command.
- Canvas pan/zoom/drag/marquee tests cover the surviving viewport
  responsibilities.

---

## Tracking matrix

A condensed view of what each phase adds:

| Phase | New test files (approx) | New fixtures |
|---|---|---|
| 0 — Guardrails | 4 architecture + 9 baseline | 0 |
| 1 — SessionHost | 1 host + 4 slots + 3 wrapper replay + 1 harness | 5 SDK streams |
| 2 — Typed bus | 4 contract + 1 bus + 1 socket | 1 broadcast snapshot |
| 3 — Agent registry | 3 tool factory + 3 agent + 1 dispatcher size + prompt-gen | 0 |
| 4.1 routing | 3 routing + 1 visual parity | 0 |
| 4.2 port lifecycle | 3 lifecycle | 0 |
| 4.3 node registry | 4 canvas behaviour + 1 controller | 1 canvas snapshot |
| 4.4 persistence | 3 repo + 1 restart | 1 fixture project |
| 5 — Decomposition | 11 command + 3 canvas + size assertions | 0 |

By the end of Phase 5 we have ~60 test files. That's the size at which
"run the tests before you commit" stays under five seconds in watch
mode and the suite remains a tool, not a chore.

---

## Risks the test plan does not eliminate

- **Real-Claude flakiness.** The SDK can produce surprising message
  shapes in the wild. Replay fixtures cover the cases we've seen, not
  the cases we haven't. Mitigation: when a new shape causes a
  user-visible bug, add it to the fixtures.
- **Cross-window concurrency.** Two browser windows on the same project
  is undefined behaviour today. Phase 2's bus design must decide
  whether peers see each other's events; we add a test once that
  decision is made.
- **Performance regressions.** Tests don't catch a 200 ms layout becoming
  a 2 s layout. If we see one, add a perf test for that specific path
  (vitest's `bench` mode), don't try to pre-emptively benchmark
  everything.
- **Visual regressions.** No screenshot tests until Phase 4. Until then,
  visual changes need a human eye in PR review.
