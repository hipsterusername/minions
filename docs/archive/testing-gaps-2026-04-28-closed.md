# Testing Gaps — 2026-04-28

**Status:** Active punch list. Closes when every section below is empty.
**Authority:** `docs/testing-strategy.md` is the rules; this document is
the work to bring the suite into compliance.

This is the output of a critical TDD audit of all 73 test files
(~19,725 LoC). It has three sections:

1. **Kill list** — tests/files to delete outright. Zero coverage loss.
2. **Rewrite list** — tests that pin the wrong thing. Replace with
   behaviour-focused assertions.
3. **Green-field list** — production surfaces with no tests at all.

Every entry references the rule in `testing-strategy.md` it was caught by.

---

## 1. Kill list (delete-without-loss)

| File / range | Rule | Action |
|---|---|---|
| `server/ws-config.test.ts` (entire 20-line file) | §5.7 (ENCODES_CONSTANT) | Delete file. Move the bracketing intent into a comment in `server/ws-config.ts`. |
| `tests/contracts/image-node.test.ts` (entire 40-line file) | §5.4 (SCHEMA_REDUNDANT) | Delete file. Re-reads literal fields from the same module that registered them; no producer/consumer flow exercised. |
| `tests/contracts/command-table.test.ts` (entire 82-line file) | §6.5 (TYPE_AS_RUNTIME) | Delete file. Replace with `COMMAND_TABLE satisfies Record<WsCommandType, CommandHandler>` in `server/commands/index.ts` (already typed; just confirm). |
| `tests/architecture/no-cross-tree-imports.test.ts:88-124` | §5.7 / §5.9 | Drop the empty-allowlist iteration block. Allowlist is empty and stays empty per §6.2. |
| `tests/architecture/no-direct-broadcast.test.ts:63-69` | §5.7 (TRIVIAL) | Drop the "bus.ts has at least one `broadcast(`" sanity. Build would break before the test could. |
| `tests/architecture/file-size.test.ts:62-64` | §5.7 (TRIVIAL) | Drop the "is reading at least a few server files" check. |
| `shared/render-dsl.test.ts:24-192` | §5.4 (SCHEMA_REDUNDANT) | Delete the 8 "accepts valid X component" + 5 "rejects invalid X" tests. Replace per §2 below. |
| `shared/routines/types.test.ts:103-394` | §5.4 (SCHEMA_REDUNDANT) | Delete tests that assert `.min(1)`, `.default(0)`, `.regex(...)`, `.enum(...)` directly. Keep `safeParseRoutine`'s **error-formatting** tests. |
| `shared/ws-envelope.test.ts:19-74` | §5.4 (SCHEMA_REDUNDANT) | Delete topic-regex-pass/fail and envelope-required-field-pass/fail. |
| `shared/ws-envelope.test.ts:115-117` | §5.7 (TAUTOLOGY) | `expect(GLOBAL_TOPIC).toBe("global")` — drop. |
| `tests/harness/sdk-messages-snapshot.test.ts:67-307` | §5.6 (SNAPSHOT_BLOB) | Delete the 5 inline snapshots. Rewrite per §2 below. |
| `tests/harness/session-stream-snapshot.test.ts:75-158` | §5.6 + §5.9 (DUPLICATE) | Delete the leader-plan-and-delegate snapshot — it duplicates `sdk-messages-snapshot.test.ts:67`. Rewrite the rest as property assertions. |
| `tests/harness/session-stream-snapshot.test.ts:341-380` | §5.1 (TAUTOLOGY) | "rebuilding via sync_response produces the same messages as live replay" — delete. The reducer is deterministic over identical input. |
| `tests/harness/ws-replay.test.ts:179-187, 216-224, 79-85` | §5.7 (TRIVIAL) | Delete the three fake-self-tests of the harness. |
| `server/bus.test.ts:96, 196, 218, 231` | §5.4 (SCHEMA_REDUNDANT) | Drop the four `wsEnvelopeSchema.safeParse` repeats — already covered by `toMatchObject` on the same fields. |
| `server/bus.test.ts:170` | §5.9 (DUPLICATE) | "broadcast (escape hatch)" duplicates the `emit*` tests above. |
| `server/bus.test.ts:147` | §5.7 (IMPL_COUPLING) | Pins a known-bug-shaped behaviour with a comment that says "flip the assertion when impl changes". Either fix the bug or remove the test. |
| `server/commands/attachment-sanitize.test.ts:9` | §5.1 (TAUTOLOGY) | "returns undefined for non-arrays" tests `Array.isArray`. |
| `server/path-guard.test.ts:28, 65, 96` | §5.1 + §5.9 | Drop home-dir-startsWith tautology + two duplicate isUnderHomeDir invocations. |
| `server/mcp-server-store.test.ts:67, 71` | §5.7 (TRIVIAL) | Two empty-fs cases — collapse to one. |
| `server/mcp-server-store.test.ts:158, 165, 171` | §5.9 (DUPLICATE) | Three near-identical "creates a new {stdio,SSE,HTTP} entry" tests — collapse to one parameterised case. |
| `server/mcp-server-store.test.ts:215` | §5.9 (DUPLICATE) | Sort-by-id reassertion. |
| `server/routines/external-mcp.test.ts:50, 60, 150, 200` | §5.7 / §5.9 | Drop the empty-input duplicate, the no-optional-fields trivial, and parameterise the SSE/HTTP describe blocks. |
| `server/routines/scheduler-dag.test.ts:170 vs 208` | §5.9 (DUPLICATE) | Two assertions on the same diamond happy path — collapse. |
| `server/routines/scheduler-dag.test.ts:185` | §5.7 (IMPL_COUPLING) | "lists dep edges" round-trips the parser, not the scheduler. |
| `server/routines/scheduler-dag.test.ts:519` | §5.7 (TRIVIAL) | "emits mode=dag" tests a constant string field. |
| `server/routines/templates.test.ts:25, 43-65` | §5.4 + §5.7 | Drop the schema-roundtrip and the `RESEARCH_ANALYZE_REPORT` literal-content tests. |
| `server/routine-persist.test.ts:520-572` | §5.4 + §5.9 | Drop the `pragma table_info` / `pragma index_list` / `openPersistDb migrates fresh file` block. |
| `server/routine-persist.test.ts:396` | §5.7 (TRIVIAL) | Drop "re-enables persistence after disable" — inverse-operation tautology. |
| `server/session-persist.test.ts:296` | §5.7 (TRIVIAL) | Drop the `disablePersistence` no-op chain. |
| `server/session-persist.test.ts:260` | §5.9 (DUPLICATE) | Drop "simulated server restart" — covered by the line-231 case. |
| `server/session-registry.test.ts:62, 67-77` | §5.7 + §5.2 | Drop the empty-registry size and the impl-coupled `map` reach-in. |
| `server/session-repo.test.ts:324, 144, 362` | §5.7 + §5.9 | Drop the `Object.keys` surface assertion, the SQLite-stores-nullable assertion, and the duplicate restart-recovery test. |
| `server/skills.test.ts:58, 68, 145` | §5.7 (TRIVIAL) | Three trivial-input cases. |
| `server/task-tools/assign-task.test.ts:294, 357, 406` | §5.7 / §5.9 | Drop the empty-skillIds emission shape and the negative-existence tests. |
| `server/ws-connection.test.ts:58` | §5.8 (LOG_SPY) | Drop the `console.warn` content assertion. |
| `src/auto-layout.test.ts:30-42, 201-211` | §5.7 / §5.9 | Drop the duplicate single-node tests and the `Number.isInteger` check. |
| `src/canvas-state.test.ts:33-37, 39-47, 57-60, 204-234` | §5.3 + §5.7 | Drop the no-mutate, no-dedupe, empty-remove, and SET_NODES-preserves-fields tests. |
| `src/canvas-utils.test.ts:19-46` | §5.7 (TRIVIAL) | Drop the `snapToGrid` arithmetic-identity tests; keep one boundary case. |
| `src/graph-runtime.test.ts:38-42, 54-60, 326-333, 376-394, 412-440` | §5.3 / §5.1 / §5.2 | Drop no-mutate, redundant edge, typeof string, "would deliver twice if scheduler bug", and "no hidden ports" cases. |
| `src/graph.test.ts:59-73, 82-92, 104-167, 194-237` | §5.9 / §5.2 / §5.7 | Collapse the 4 unknown-lookup cases, the 3 lifecycle-default cases, the 3 mock-of-self lifecycle tests; drop the "returns undefined for never-registered" trivial. |
| `src/kanban-types.test.ts:46-54, 68-72, 202-213, 236-244, 336-378` | §5.3 / §5.7 / §5.9 | Drop no-mutate, REMOVE no-op, ADD_SUBTASK trivial, SET_BOARD reference equality, UNBLOCK/RESUME alias, and `default:` clause tests. |
| `src/mcp-paste-parser.test.ts:307-309, 336-345` | §5.7 / §5.9 | Drop `String#toLowerCase` and the round-trip-of-already-tested-pieces. |
| `src/model-meta.test.ts:6-10` | §5.2 (MOCK_OF_SELF) | Delete file or rewrite. The function is `(k) => MAP[k]` and the test reads the same map. |
| `src/nodes/image-loader.test.ts:29-38` | §5.9 (DUPLICATE) | Boundary-case duplicate. |
| `src/nodes/LeaderNode.test.ts:46-66` | §5.7 / §5.9 | Drop the three empty-input early-exit tests; keep one. |
| `src/nodes/markdown-node-factory.test.ts:23-36` | §5.7 (TRIVIAL) | Drop the empty/whitespace + `dispatch.not.toHaveBeenCalled` cluster. |
| `src/nodes/rasterize-annotations.node.test.ts:222-272` | §5.7 (TRIVIAL) | Drop the `fingerprintAnnotations([]) === "0"` and empty-cache tests. |
| `src/prompts/build-leader-prompt.test.ts:88-93` | §5.7 (IMPL_COUPLING) | Drop the `(no description)` substring test. |
| `src/render-flatten.test.ts:25-180` | §5.6 / §5.7 | Drop the literal-format pinning. Replace per §2 below. |
| `src/routine-context-paths.test.ts:62-77` | §5.9 (DUPLICATE) | Trim the 10-case `it.each` to 3-4 representatives. |
| `src/sdk-messages.test.ts:170-285` | §5.1 / §5.7 | Drop `msgId` regex tests, the "1 system message" length+role triad, the emoji-glyph tests, and the status-subtype default-fallthrough. |
| `src/session-stream.test.ts:178-247` | §5.7 (IMPL_COUPLING) | Drop reference-equality early-return and message_delta-doesn't-end-stream-by-reference. |
| `src/skills/built-in/index.test.ts:41-58` | §5.9 / §5.2 | Collapse the documented-by-id test into the exact-set test; drop the idempotency-of-`registerSkill` test. |
| `src/streaming.test.ts:108-254` | §5.9 (DUPLICATE) | Collapse the 5+ near-identical type-guard null-return cases across `extractStreamDelta` / `isStreamEnd` / `isStreamingEvent`. |
| `src/usage-aggregator.test.ts:83-91, 206-215` | §5.3 / §5.7 | Drop no-mutate and `shortModelLabel` regex pinning. |
| `src/UsagePopover.test.tsx` (entire file) | §5.5 (TRIVIAL) | Every assertion is `getBy* + .toBeDefined()`. Either rewrite to test something falsifiable or delete the file. |
| `src/SessionPanel.test.tsx:100-128` | §5.5 (TRIVIAL) | 6 `.toBeDefined()` matchers — drop. The queries already carry signal. |
| `src/RoutinePromptEditor.test.tsx:114-121` | §5.5 (TRIVIAL) | 4 `getByTitle.toBeTruthy()` — drop. |
| `src/BottomRightDock.test.tsx:69-73` | §5.5 (TRIVIAL) | 4 `.toBeDefined()` — drop. |
| `src/nodes/RoutineNode.test.tsx:237-439` | §5.5 (TRIVIAL) | 9 `.toBeTruthy()` across 3 tests — drop the matchers. |
| `src/nodes/ImageNode.test.tsx:276-291, 335-342, 489-546` | §5.5 (IMPL_COUPLING) | Drop the inline-style assertions and the DOM-API-counter test. |
| `src/components/AnnotationSidebar.test.tsx:216-229` | §5.5 (IMPL_COUPLING) | Drop the inline-flex and `data-no-drag` attribute-only tests; replace with drag-propagation behaviour test if drag matters. |
| `src/RoutineEditor.test.tsx:508-557` | §5.5 + §5.9 | Drop the rail-button existence smoke and the duplicate drill-into-step test. |

**Total:** ~100 distinct removals across ~50 files. Estimated 2,500–3,500 LoC
of test code deleted with **zero** coverage loss.

---

## 2. Rewrite list (replace with behaviour-focused tests)

### 2.1 `shared/render-dsl.test.ts`

After the kill-list deletions land, the file should contain ONE round-trip
test per component variant, using the real `applyRenderMessage` consumer
and the real server-side render-tool emitter:

```ts
// PSEUDOCODE
import { applyRenderMessage } from "../../shared/render-dsl.ts";
import { createRenderTools } from "../server/render-tools.ts";

it("metric component round-trips from render_set tool to client state", () => {
  const { tools } = createRenderTools(/* fake bus */);
  const captured = capture(() => tools.render_set.handler({
    components: [{ id: "k", type: "metric", label: "L", value: "V" }],
  }));
  // captured is what the bus would emit; feed it through the real client reducer.
  const next = applyRenderMessage(emptyRenderState(), captured);
  expect(next.components.find((c) => c.id === "k")).toMatchObject({
    type: "metric", label: "L", value: "V",
  });
});
```

A regression in either side of the contract surfaces. A regression in zod
does not.

### 2.2 `shared/routines/types.test.ts`

Keep:
- `safeParseRoutine`'s **error-formatting** tests — the editor consumes
  `formattedError`. The contract is the formatted message's shape, the
  joined path, and the per-field grouping.
- One round-trip per failure-policy / step-type combination, exercising
  a real producer (e.g. a built-in template) and a real consumer
  (the scheduler).

Delete everything else.

### 2.3 `shared/ws-envelope.test.ts`

Replace topic-regex pass/fail with:

```ts
it("every server bus.emitTaskUpdate produces a payload that parses through the envelope", () => {
  const captured = capture(() => bus.emitTaskUpdate(/* real args */));
  const parsed = wsEnvelopeSchema.safeParse(captured);
  expect(parsed.success).toBe(true);
  expect(parsed.data.topic).toBe("session/<id>");
});
```

One per `emit*` site. The envelope schema is exercised through the producer.

### 2.4 `tests/harness/sdk-messages-snapshot.test.ts`

Replace each ~80-line inline snapshot with property assertions:

```ts
const messages = sdkToDisplayMessages(loadFixture("leader-plan-and-delegate"));

it("produces 7 display messages in the expected role sequence", () => {
  expect(messages).toHaveLength(7);
  expect(messages.map((m) => m.role))
    .toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]);
});

it("the first tool call is plan_task with three planned tasks", () => {
  const tool = messages.find((m) => m.role === "tool" && m.toolName === "plan_task");
  expect(tool).toBeDefined();
  expect(tool!.input.tasks).toHaveLength(3);
});

it("the streaming-end marker arrives on the last assistant turn", () => {
  expect(messages.at(-1)).toMatchObject({ role: "assistant", streamingEnded: true });
});
```

Five per fixture, not one 80-line blob. A regression in the conversion
surfaces with a targeted diff. A CSS or copy change does not regenerate
a snapshot.

### 2.5 `tests/harness/session-stream-snapshot.test.ts`

Same rewrite. Drop the duplicate fixture (covered by 2.4); keep only the
fixtures that exercise reducers `sdk-messages-snapshot` doesn't reach.

### 2.6 `src/render-flatten.test.ts`

Replace `expect(out).toContain("# Overview")` style with property assertions:

```ts
it("emits a top-level heading per render section", () => {
  const out = renderFlatten(state);
  const headings = out.match(/^# .+$/gm) ?? [];
  expect(headings).toHaveLength(state.sections.length);
});
```

The format may evolve; the property holds across versions.

### 2.7 `src/UsagePopover.test.tsx`

Either delete or rewrite to test:
- Sorting (most-expensive model appears first).
- Aggregation (multiple sessions for the same model collapse to one row
  with summed cost).
- Empty state (a meaningful element renders when `usage.size === 0`).

Each as a single `expect` that compares an array of visible-text values
to an expected array — no `.toBeDefined()`.

### 2.8 `tests/architecture/file-size.test.ts`

Add a baselines-monotonicity test (per §6.1):

```ts
import { execSync } from "node:child_process";
it("baselines.ts entries have not been ratcheted up since the last commit", () => {
  // Read git-blob versions of baselines.ts at HEAD~1 and HEAD; for every
  // shared key, assert HEAD value <= HEAD~1 value.
});
```

A PR that bumps a baseline up fails CI without an explicit
`// RATCHET_UP_OK: <reason>` annotation.

---

## 3. Green-field list (untested production surfaces)

These have **no** colocated test today. Each entry is a test obligation
under §7 of the strategy. Listed in priority order — top items are the
ones a regression would hurt users most.

### 3.1 Critical (write before next refactor)

| File | Layer | What to test |
|---|---|---|
| `server/session-host.ts` | L1 | Lifecycle: start, abort, query loop, persistence callbacks. Mock SDK at the boundary. |
| `server/session-host-run.ts` | L1 | Run-loop transitions, abort race, query-error handling. |
| `server/session-host-config.ts` | L1 | Config build per role × permission mode × allowed-tools. |
| `server/agents/registry.ts` | L1 | Lookup, register, list, override. |
| `server/agents/leader.ts`, `agents/minion.ts`, `agents/default.ts` | L1 | Each agent's tool list, prompt template, MCP server binding. |
| `server/render-tools.ts` | L2 | Each render tool factory: invoke handler, capture broadcast, parse envelope, assert state. |
| `server/minion-tools.ts` | L2 | Each tool: handler invocation + state mutation + emitted broadcast. |
| `server/db.ts` | L1 | Migration on a fresh tmpdir; no destructive migrations across versions. |
| `server/project-store.ts` | L1 | Register / list / unregister round-trip; conflict on duplicate path; concurrent open. |
| `server/worktree-create.ts` | L1 | Mock `child_process`; assert git invocation + stderr surface + cleanup on failure. |
| `server/worktree-merge.ts` | L1 | Three-way merge, conflict surfaces, error translation. |
| `server/worktree-diff.ts` | L1 | Diff format + binary-file branch. |
| `server/worktree-exec.ts` | L1 | Stdio routing, exit-code translation, abort on signal. |
| `src/use-socket.ts` | L1 | Reconnect logic, `sync_response` handling, message routing, backoff. |

### 3.2 Important (write within the quarter)

| File | Layer | What to test |
|---|---|---|
| `server/commands/<28 untested>.ts` | L2 | Each WS command: handler invocation, state mutation, emitted broadcast, error surface. Currently only `attachment-sanitize` and `create-session` are covered. |
| `server/task-tools/<6 untested>.ts` | L2 | `complete-task`, `get-task-status`, `plan-task`, `request-approval`, `set-task-name`, `wait-and-continue`. Cover happy path + error path + state-already-completed guard. |
| `server/routes/<all subdirs>.ts` | L2 | Real Express + supertest round-trips per route. Pattern: `tests/contracts/routine-routes.test.ts`. |
| `server/routine-registry.ts` | L1 | Built-in registration + custom override + lookup. |
| `server/routines/session-end.ts` | L1 | Termination paths + cleanup on partial failure. |
| `server/routines/step-tools.ts` | L2 | Per-step tool factories — same shape as render-tools. |
| `src/use-autosave.ts` | L1 | Debounce + flush + cancel-on-unmount. |
| `src/use-canvas-keyboard.ts` | L1 | Keyboard mapping; modifier combinations. |
| `src/use-canvas-file-drop.ts` | L1 | File-drop dispatch; reject paths outside the project. |
| `src/wheel-detector.ts` | L1 | Trackpad vs mouse heuristic; the inputs it must distinguish. |
| `src/api.ts` | L1 | Fetch wrapper; error translation; auth header. |
| `src/node-registry.ts` | L1 | Register / lookup / fallthrough; idempotent re-registration. |
| `src/skills/registry.ts` | L1 | Register / lookup. |
| `src/skills/user-skills.ts` | L1 | Load / save round-trip; sanitisation of user input. |
| `src/canvas-scale.ts` | L1 | Scale-to-fit math at boundary inputs. |

### 3.3 Component layer (write opportunistically)

| File | Layer | What to test |
|---|---|---|
| `src/Canvas.tsx` | L3 | Keyboard nav, drag start/end, edge add/remove. The file is large enough that tests are protective, not optional. |
| `src/CanvasNode.tsx` | L3 | Drag, select, port socket; passthrough of node-specific props. |
| `src/EdgeRenderer.tsx` | L3 | Port-anchor math at scale; not visual — assert on the SVG path's start/end coordinates. |
| `src/components/markup-palette.tsx` | L3 | Tool selection, click, drag-out. |

### 3.4 Hooks (low-priority, but on the matrix)

| File | Layer | Why |
|---|---|---|
| `src/use-theme.ts` | L1 | Trivial today; add a test only if branching grows. |

---

## 4. Closure plan

Sequence the work in three waves.

**Wave 1 (this sprint) — DONE.**

1. ✅ Kill list landed — ~3,000 LoC of test deletion across ~50 files.
   `getBy*+toBeDefined()` is at zero in `src/`; the surviving
   `getBy*+toBeTruthy()` matches are removal-trail comments documenting
   the cleanup, not live code.
2. ✅ `tests/architecture/no-banned-assertions.test.ts` — lint added.
   Catches `getBy*+toBeDefined`, `getBy*+toBeTruthy`, inline-style
   `flex` regex, and CSS-token `--*` substring assertions. Verified
   against an injected canary violation.
3. ✅ `tests/architecture/no-baseline-ratchet-up.test.ts` — lint added.
   Compares `SERVER_FILE_SIZE_ALLOWLIST` against `git show HEAD~1`;
   raises require an inline `// RATCHET_UP_OK: <reason>` waiver.
4. ✅ `tests/contracts/command-table.test.ts` deleted; the
   `COMMAND_TABLE: CommandTable` declaration in
   `server/commands/index.ts` is the compile-time guard. (Confirmed
   in this audit pass.)

**Wave 2 (next sprint).**

5. Rewrites in §2 — schema round-trips that exercise real producers
   (render-DSL via `applyRenderMessage` + `createRenderTools`,
   ws-envelope via `bus.emit*`, routine schema via `parseRoutine` +
   the scheduler). Stub comments are already in place at the top of
   the trimmed test files calling out the rewrites by §2.x label.
6. Critical green-field tests in §3.1.
   - ✅ `server/session-host.test.ts` (10 tests) — happy-path
     lifecycle, error path, abort mid-stream, retention cap, wait-timer
     idempotency, role inheritance. Mocks the SDK at the boundary;
     uses `disablePersistence()` so no SQLite is touched.
   - ✅ `server/render-tools.test.ts` (8 tests) — append-dedup
     regression, set-clears-title-on-omit, onStateChange-per-mutation.
   - ✅ `server/minion-tools.test.ts` (7 tests) — parameterised over
     report_step / report_done / report_fail; envelope shape, ack
     structure, multi-call ordering. Required adding `tools` to the
     factory return value to match the render-tools convention.
   - ✅ `server/db.test.ts` (5 tests) — fresh-DB round-trip on every
     documented table, foreign-key enforcement, idempotent re-open,
     session_id one-shot migration on legacy schemas.
   - ✅ `server/project-store.test.ts` (11 tests) — sidecar init,
     openProjectDb idempotency, context/settings/skills/mcp-servers
     round-trips, recent-projects index (add, dedupe, remove, 20-cap).
     Uses `vi.mock("node:os")` + `vi.hoisted` to redirect homedir to
     a per-pid tmp path; pollution of the real `~/.claude-canvas/`
     is prevented.
   - ✅ `server/worktree-exec.test.ts` (7 tests) — wrapper happy path,
     stderr/stdout fallback chain on errors.
   - ✅ `server/worktree-create.test.ts` (8 tests) — createWorktree
     git args + WorktreeInfo shape, removeWorktree derivation,
     listWorktrees porcelain parsing with canvas-only filter,
     isGitRepo, cleanupStaleWorktrees prune + rmdir.
   - ✅ `server/worktree-diff.test.ts` (7 tests) — getWorktreeStatus
     stat parsing (plural / singular / binary / empty), getDetailedDiff
     committed+uncommitted accumulator with name-status enrichment,
     merge-base fallback to HEAD, binary-file `-` numstat handling.
   - ✅ `server/worktree-merge.test.ts` (10 tests) — happy path,
     conflict→rebase-success, conflict→rebase-fail with conflict file
     list, strategy="ours" / force=true / strategy="theirs" with
     per-file checkout resolution, mergeAndCleanup auto-commit and
     success-vs-failure cleanup branches.
   - ✅ `src/use-socket.test.tsx` (12 tests) — auth-token URL
     construction, topic filtering, send-when-OPEN drop-when-closed,
     auto-reconnect with exponential backoff, transitions to 'failed'
     after MAX_RECONNECT_ATTEMPTS=10, manualReconnect resets counter
     and suppresses double-reconnect.
   - Remaining: `server/session-host-run.test.ts`,
     `server/session-host-config.test.ts`, `server/agents/*.test.ts`.

**Wave 3 (within the quarter) — DONE.**

7. ✅ All 32 WS commands covered (was 3, now 32 via 22 new test files).
   Includes `info-queries` (6 handlers parameterised), the 4 merge-flow
   commands collapsed into `merge-flow.test.ts`, `interrupt` covering
   both `interrupt`/`interrupt_session`, plus per-command tests for
   send-message, sync-session, remove-session, list-routines,
   start-routine, abort-routine, mcp-control, seed-read-state,
   rewind-files, list-sessions, close-session, stop-session, set-model,
   set-permission-mode, stop-task, get-worktree-diff, merge-worktree,
   discard-worktree.
8. ✅ All 6 untested task-tools covered (plan-task, complete-task,
   get-task-status, set-task-name, wait-and-continue, request-approval).
   29 tests across the 7 task-tool files.
9. ✅ Server REST routes under `server/routes/*`. Three new contract
   tests under `tests/contracts/`:
   - `projects-core-routes.test.ts` (12 tests) — POST /, POST /open,
     GET / list, GET /:encodedPath, PUT /:encodedPath, DELETE, PUT
     /state bulk save (replace-not-append).
   - `projects-settings-routes.test.ts` (10 tests) — context / settings
     / skills / mcp-servers GET+PUT round-trips, mcp-servers DELETE,
     malformed-payload rejection.
   - `projects-files-routes.test.ts` (11 tests) — /file truncation
     above 512KB, path-traversal 403, /ls dir-then-file sort with
     node_modules filter, /tree depth clamp at 4.
10. ✅ Schema producer rewrites (§2.1, §2.3).
    - `tests/contracts/render-dsl-roundtrip.test.ts` (5 tests) drives
      the real `createRenderToolsForLeader` producer through every
      component variant and verifies `applyRenderMessage` arrives at
      the same state via the captured envelope.
    - `tests/contracts/ws-envelope-roundtrip.test.ts` (6 tests) drives
      every `bus.emit*` and `unicast*` site and asserts the captured
      payload parses through `wsEnvelopeSchema` with the expected
      topic.
11. ✅ Snapshot harness rewrite (§2.4, §2.5).
    `tests/harness/sdk-messages-snapshot.test.ts` was deleted entirely
    in an earlier round (duplicate fixture coverage). The surviving
    `tests/harness/session-stream-snapshot.test.ts` is now property
    assertions throughout — role sequences, content strings, cost +
    turns capture, intermediate buffer states. The header comment
    documents the rewrite.
12. ✅ First mutation-testing rotation on `canvas-state` +
    `graph-runtime` per §6.4 — and the immediate follow-up to close
    the gaps it surfaced.

    **Run 1 (initial):**
    - `graph-runtime.ts` — **88.70%** (above the 80% threshold).
    - `canvas-state.ts` — 44.44% total (78.43% covered) — 39 mutants
      landed on lines no test exercised (the `useCanvasHistory`
      hook had no DOM-env coverage at all).

    **Closing tests added:**
    - `src/canvas-state.dom.test.tsx` (12 tests) — exercises
      `useCanvasHistory` initial state, dispatch + history tracking,
      undo/redo behaviour, MAX_HISTORY=50 cap, and `generateId`
      monotonicity.
    - `src/graph-runtime.test.ts` augmented with per-field
      ADD_EDGE idempotency discrimination (4 tests) plus
      `createEdge` branch coverage (3 tests) — including a regex-
      anchored counter check that catches `+= 1` ⇒ `-= 1`.
    - `src/canvas-state.test.ts` — multi-node UPDATE_NODE_DATA
      assertion + a SET_NODES test that exercises the future stack
      to discriminate `HISTORY_ACTIONS.has` vs `if (true)`.

    **Run 2 (post-follow-up):**
    - `graph-runtime.ts` — **98.26%** ✅ (was 88.70%).
    - `canvas-state.ts` — **90.00%** ✅ (was 44.44%).
    - All files — **94.63%** total (was 69.27%).

    **Remaining ~11 survivors are equivalent mutants:**
    - `>` vs `>=` on the `MAX_HISTORY` cap reduces to identical
      behaviour because `splice(0, 0)` is a no-op when length only
      grows by 1.
    - `if (past.length > MAX) → if (true)` — the splice math
      `past.length - MAX_HISTORY` is negative in the small-array
      case, so `splice(0, negative)` is a no-op, indistinguishable
      from skipping the branch.
    - `tick` callback internals (`setTick(t => t + 1)` mutated to
      various no-ops, dependency arrays mutated to `[]`) — `tick`
      only forces a re-render to refresh `canUndo`/`canRedo`. These
      values are also refreshed by the `setNodes` re-render, so
      the React tree stays consistent under most mutations.
    - The `targetNodeData !== undefined` short-circuit and
      `if (!srcPort)` guard in `createEdge` need contracts crafted
      to discriminate them — beyond the practical reach of the
      current contract registry. Documented as belt-and-braces
      guards.

When this document goes empty, archive it as
`docs/testing-gaps-2026-04-28-closed.md` and run a fresh audit. Drift is
a bug; an empty gap document is the only way to know the suite tells the
truth.
