# Senior Architectural Consulting Review — Minions

**Date:** 2026-07-03
**Scope:** Full-codebase architecture review — server, frontend, shared contracts, testing/operational posture.
**Method:** Four parallel deep-dive reviews (read-only), synthesized here. Detailed
findings with file:line evidence live in the appendices:

| Appendix | Coverage | Findings |
|---|---|---|
| [`server.md`](./server.md) | Session lifecycle, bus, commands, worktree/merge, persistence, harness seam | 12 |
| [`frontend.md`](./frontend.md) | Canvas state, node system, streaming pipeline, rendering performance | 12 |
| [`contracts.md`](./contracts.md) | WS protocol, render DSL, NormalizedEvent, architecture-test coverage | 12 |
| [`quality.md`](./quality.md) | Testing-strategy drift, CI, logging, recovery, telemetry, dependencies | 12 + 15-item scorecard |

---

## Executive summary

Minions is in **unusually good architectural shape for an early-stage project**.
The bones are right: a typed event bus with an enforced single broadcast
chokepoint, a per-command handler table with exhaustive inbound zod validation,
a real (if imperfect) harness seam for model agnosticism, a pure task-lifecycle
reducer, a merge strategy that is deliberately safer than naive checkout-merge,
and an architecture-fitness test suite with a one-way ratchet that has already
demonstrably reversed file-size debt on the server. The testing culture —
3,388 tests running in ~7 seconds, a written working agreement with an
anti-pattern taxonomy — is well beyond the norm.

The consulting findings cluster into four themes, in priority order:

1. **The trust-critical path (worktree approval/merge/termination) has real
   correctness gaps** — unserialized merge commands, leader teardown that can
   strand running minions, merge success misreported as failure, orphaned
   worktrees — and these are *exactly* the commands with no tests. Two
   independent reviews converged on this without coordination.
2. **Contract discipline is asymmetric.** Inbound WS commands are rigorously
   validated; outbound events are envelope-only, with a hand-mirrored client
   union and repeated `unknown as` casts in `Canvas.tsx`. The type system stops
   at the tree boundary — precisely where the architecture claims its strength.
3. **The frontend grew by accretion where the server grew by design.**
   `Canvas.tsx` (4,626 lines) is an orchestration god-component; state is split
   across reducers, refs, localStorage, and node data; a known duplicate-message
   bug is pinned by a test that *asserts the bug*.
4. **Operational posture trails the architecture.** Console-only logging,
   silent persistence degradation, no dispatch exception boundary, and a test
   suite that is currently red on `main`.

None of these are foundation problems. They are the predictable gaps of a
system that got the architecture right and is now due its first
correctness/robustness consolidation pass.

---

## Scorecard

| Area | Grade | One-line assessment |
|---|---|---|
| Server architecture | **B+** | Well-factored, real seams; lifecycle and merge-path races are the gap |
| Frontend architecture | **C+** | Good primitives (`useSessionStream`, registry, memoized nodes) buried in god-components |
| Shared contracts | **B−** | Inbound half is exemplary; outbound half is convention, not contract |
| Testing posture | **A−** | Rare discipline; drift between strategy §7 and the tree, one red test |
| Operational posture | **C** | Fine for local dev; silent failure modes will hurt as usage grows |
| Docs/process | **A−** | The testing strategy is a genuine working agreement; keep it honest |

---

## What's genuinely good (preserve these)

- **The bus + envelope + fitness-test pattern.** `server/bus.ts` is small,
  documented, honest about non-goals, and the "no broadcast outside the bus"
  test makes the invariant durable. This is the template for the rest.
- **The safer-than-git-default merge strategy** (`server/worktree-merge.ts`):
  merge into the isolated branch, atomically advance the target ref with an
  old-SHA guard, hard-reset main only when clean.
- **Per-command / per-tool file factories.** ~35 WS commands and 12 task tools
  each in small, individually tested modules — the anti-god-file pattern works.
  task-lifecycle reducer with guarded terminal states.
- **The one-way ratchet.** The strategy documents how baselines used to creep
  upward and closed that door. `server/index.ts` was drained from ~2,000 lines.
- **`useSessionStream` + `sessionStreamReducer`** — the correct streaming
  consolidation already exists; it just hasn't finished its migration.
- **MCP bridge security instincts:** loopback binding, per-session bearer
  tokens, constant-time comparison, explicit disposal.

---

## Theme 1 — Harden the trust-critical path (highest priority)

The approval/merge/termination flow is the product's trust contract: "nothing
reaches your branch without approval, and discard really discards." Four
findings puncture it (evidence in `server.md` §1–3, §10):

- **Leader close/remove can strand running minions.** `close-session.ts` and
  `remove-session.ts` build partial termination deps omitting
  `terminateSession`, so `cancelChildrenOnLeaderTeardown()` marks child tasks
  cancelled while minion processes keep running — spending tokens and possibly
  mutating the inherited worktree the UI says is dead.
- **Merge commands are not serialized.** `approve_changes` / `force_merge` /
  `theirs_merge` / `retry_merge` have no per-session in-flight guard. Two tabs
  or a double-click can race two merges on the same branch/worktree.
- **A successful merge can be reported as a failure.** If `removeWorktree()`
  throws after the target ref has already advanced, the whole flow rejects —
  the UI shows a failed merge for a branch that merged.
- **Remove-session deletes durable state before cleanup succeeds**, so a failed
  worktree removal leaks a `.canvas-worktrees` entry with nothing left to
  retry from.

And the convergent finding from the quality review: **these exact commands are
the ones with no colocated tests** (`quality.md` §4).

**Recommendations (do these first):**

1. Add `SessionRegistry.terminate(sessionKey, reason)` that always carries the
   canonical deps; forbid handlers from hand-rolling termination deps.
   Regression test: close a leader with a running minion → minion host aborted.
2. Add a per-session operation lock for destructive worktree actions with
   idempotent duplicate handling. Test: duplicate `approve_changes` from two
   sockets.
3. Split merge result from cleanup result (`{ merge, cleanup }`); persist
   `cleanup_failed` as a recoverable lifecycle state instead of failing the
   whole flow. Same state-transition treatment for remove-session cleanup.
4. Write the missing command tests for the five merge/approval commands —
   they are the cheapest insurance in the codebase.

---

## Theme 2 — Finish the contract: outbound events (highest leverage)

Inbound commands enjoy `COMMAND_SCHEMAS: Record<WsCommandType, z.ZodType>` —
exhaustive, compiler-checked, validated before dispatch. Outbound events get an
envelope-header check and a cast (`envelope as unknown as ServerMessage`,
`src/use-socket.ts:313`), a hand-maintained client union with "must be kept in
sync" comments, and seven `unknown as` cast sites in `Canvas.tsx`'s event
routing (evidence: `contracts.md` §1, §3, §10; `frontend.md` §7).

This is one investment that pays four reviews' worth of findings:

1. **Create `shared/ws-events.ts`:** a discriminated zod union of every
   outbound event type. Server producers type against it; `useSocket` infers
   the client union from it (`z.infer`) and validates payloads before listener
   delivery. Delete the hand-mirrored union and the Canvas casts.
2. **Add `normalizedEventSchema`** so harness output is a runtime contract, not
   a TS-only convention — this is also what makes the model-agnosticism story
   auditable (currently Claude-specific shapes leak through `agent_spawned`,
   `parent_tool_use_id` semantics, and init metadata; `contracts.md` §6).
3. **Add a protocol hello.** One `{ type: "protocol_hello", protocolVersion,
   capabilities }` on connect turns deploy skew from silent weirdness into an
   explicit, testable condition.
4. **Guard the escape hatches:** rename bus `emit()` to signal it bypasses
   topic construction, and add the architecture test for "every bus event type
   has a schema" once the union exists.

---

## Theme 3 — Pay down frontend accretion on the server's pattern

The server proved the playbook: ratchet + extraction + per-concern files. Apply
it to the client (evidence: `frontend.md` §1–5, §9–11):

1. **Fix the pinned duplicate-message bug** by migrating `ClaudeSessionNode` to
   `useSessionStream` and deleting its divergent reducer. Flip
   `streaming-duplicate-bug.test.tsx` from asserting the bug to asserting the
   fix. This is the single best bug-fix-per-effort item in the review.
2. **Extract `Canvas.tsx` by responsibility, not JSX:** `useLeaderCanvasEvents`
   (the ~400-line WS reducer at ~3359–3752) first, then
   `useCanvasSessionSpawner`, `useConnectionDrag`, `useCanvasInteractionState`.
3. **Extend the client ratchet** to every `src/` file over ~1,000 lines
   (`KanbanBoard.tsx`, `RenderNode.tsx`, `MarkdownNode.tsx`, `App.tsx`, …) —
   shrink-only, same as the server. Today only three client files are gated.
4. **Normalize node state** (`{ byId, order }` + per-node subscription/selector)
   to stop whole-canvas render cascades under WS floods; add viewport culling
   when board sizes warrant it.
5. **Promote registry capabilities** (defaultData, minimap style, context
   extraction, drop behavior) to kill the `node.type === "..."` switch sprawl
   across Canvas, defaults, minimap, keyboard, and Kanban.
6. **Decide Kanban persistence:** localStorage today vs project API for
   everything else — unify or explicitly version it, and stop Kanban mutating
   leader node data through props.
7. **Decide undo:** the history hook exists but isn't wired (`App.tsx` uses
   plain `useReducer`; Canvas accepts `undo`/`redo` props nobody passes).
   Ship it above both reducers with semantic transactions, or delete it.

---

## Theme 4 — Operational floor: make failure visible

Evidence: `server.md` §4–7, §9; `quality.md` §1, §6–9.

1. **Green the suite.** `pnpm test:run` is red on `main`
   (`LeaderNode.test.tsx` grouped-tools label). Everything else in the working
   agreement depends on a green baseline.
2. **Exception boundary around WS dispatch.** One synchronous throw in a
   handler can currently take down the process. Narrow try/catch in
   `dispatchCommand()` → session-scoped error event + stack log. Add per-client
   send error handling in `broadcast()` while there.
3. **Surface persistence degradation.** Today a failed DB open silently
   disables persistence and the session keeps running non-durably. Emit a
   "persistence degraded" health event and show it in the UI.
4. **Minimal structured logger** (level + component + sessionKey/projectId,
   console sink). Not an observability stack — just stop ad-hoc string
   formatting so failures can be correlated by session.
5. **Transactionalize multi-statement writes** (`persistTaskState`,
   `removePersistedSession`, the task-record PK migration) and **cap
   `event_log` on write** — it is currently append-only and is the most likely
   first scaling failure.
6. **Adopt `PRAGMA user_version` migrations** before the schema outgrows
   `ensureColumn()` patching.

---

## Theme 5 — Keep the working agreement honest (low effort, high credibility)

The testing strategy's §7 matrix says "every cell is a contract" — the audit
found ~7 drifted cells (missing route/registry/session-end/step-tools/worktree
tests, missing client NEW tests, stale filenames, and an oxlint story that was
never wired; `quality.md` scorecard + §2–5). The document's own maintenance
section calls drift a bug. Fix in one PR: mark completed rows, list open gaps
with owners, and either wire oxlint into CI or officially bless the vitest
architecture gate as the lint substitute.

Also from the harness seam review (`server.md` §8): registration by
side-effect import, hard-coded Claude/Codex defaults in `project-store.ts`, and
an ambiguous `mcp: true` capability mean a fourth harness costs more than
implementing the interface. A `HarnessDescriptor` owning defaults, model
compatibility, and MCP capability flags would make the model-agnosticism claim
structural.

---

## Prioritized roadmap

| # | Item | Impact | Effort | Theme |
|---|---|---|---|---|
| **Now (correctness)** | | | | |
| 1 | Fix red test on main | High | XS | 4 |
| 2 | Centralized `registry.terminate()` + leader-teardown regression test | High | S | 1 |
| 3 | Per-session merge/approval lock + idempotency + the 5 missing command tests | High | M | 1 |
| 4 | Split merge vs cleanup results; `cleanup_failed` recoverable state | High | M | 1 |
| 5 | WS dispatch exception boundary + per-client send guard | High | S | 4 |
| **Next (leverage)** | | | | |
| 6 | `shared/ws-events.ts` outbound contract; retire hand-mirrored union + Canvas casts | Very high | M–L | 2 |
| 7 | Migrate `ClaudeSessionNode` → `useSessionStream`; flip duplicate-bug test | High | M | 3 |
| 8 | Extract `useLeaderCanvasEvents` from Canvas; extend client ratchet to all >1k-line files | High | M | 3 |
| 9 | Persistence transactions + event-log retention + degraded-health event | Med-high | M | 4 |
| 10 | Protocol hello / version handshake | Medium | S | 2 |
| **Later (scale & polish)** | | | | |
| 11 | `normalizedEventSchema` + provider-neutral event vocabulary + `HarnessDescriptor` | Medium | M | 2/5 |
| 12 | Node state normalization + per-node subscriptions + viewport culling | High | L | 3 |
| 13 | Registry capability promotion (kill type-switch sprawl) | Medium | M | 3 |
| 14 | Kanban persistence unification; undo decision | Medium | M | 3 |
| 15 | Structured logger + internal counters; versioned migrations | Medium | M | 4 |
| 16 | Testing-strategy §7 reconciliation + lint-story decision | Medium | S | 5 |

**Suggested sequencing:** items 1–5 are one focused hardening sprint on the
trust path — small, testable, and they close the gap between what the product
promises (isolation + approval) and what the code guarantees. Item 6 is the
single highest-leverage architectural investment and should precede any large
frontend refactor, because typed outbound events make the Canvas extraction
(items 7–8) mechanical instead of archaeological.

---

## Closing note

The distinguishing feature of this codebase is that it already knows how to fix
itself: the ratchet pattern, the fitness tests, and the per-concern file
factories are proven in-repo. Every recommendation above is an application of
a pattern the project already validated on the server — extended to the merge
path, the outbound protocol, and the frontend. That is a much better position
than most projects at this stage: the work is consolidation, not rescue.
