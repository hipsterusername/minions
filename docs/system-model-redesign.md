# System Model Redesign — Relevance-Scoped Context

Status: **draft for approval** · Supersedes the retrieval/gating/injection/health
mechanics of `docs/system-model-implementation-plan.md` (the packet, merge-gate,
reconciliation, and seeding architecture from that plan stand unchanged).

---

## 1. Why

The layer's core goals: give agents *relevant* capability/flow/constraint
context, gate genuinely risky surfaces, keep the model fresh and trustworthy.
Measured behavior (2026-07-06 assessment, `.minions/canvas.db` + repo):

| Defect | Evidence |
|---|---|
| Applicability covers ~everything | `gate.architecture_review` globs match 583/619 (94%) of tracked TS/TSX; `constraint.bus_only_broadcasts` (critical) applies to `server/**/*.ts`; `constraint.no_cross_tree_imports` to all three trees. The "packet required" predicate is effectively `true` for any code task. |
| Retrieval returns most of the model | `query_system_model` substring-matches over `JSON.stringify(object)` — ids, globs, link ids all count as text — then expands 1 hop of links through hub nodes. "worktree" → 19/25 objects, "session" → 21/25, "server"/"test"/"" → 25/25 (~4.6k tokens). |
| Prompt drives unconditional pull | `appendSystemModelAddendum` tells every leader to "use query_system_model for planning context" whenever mode ≠ off. |
| Health signal is broken | Query usage recorded with `workPacketId = leaderSessionKey`, which never joins `work_packets` → `model_health` reports every object unused; 0 packets ever created; prune list untrustworthy. |

The good news: a real scored matcher already exists
(`server/system-model/match.ts`: name×3 / keyword×2 / flow×2 / summary×1 /
file×4, topK, confidence tiers) — it is simply not used by the query tool.

## 2. Design principles

1. **Relevance is computed, never assumed.** The model enters an agent's
   context only when a deterministic signal (scored match, glob hit) says it
   applies. No unconditional "go query the model" prompting.
2. **Applicability metadata must be narrow to be meaningful.** A gate or
   critical constraint whose globs cover most of the repo carries zero
   information. Repo-wide invariants that CI already enforces do not get
   gates; their model objects point at the *enforcement surface*.
3. **Structural over prompt.** The packet-required rule moves from prose in
   the leader prompt to a deterministic computation inside `plan_task` /
   `assign_task`, whose result is surfaced only when it fires.
4. **Health data must be trustworthy or absent.** Usage attribution joins
   correctly, and overbreadth itself becomes a lint the health tool reports —
   so this failure mode cannot silently return.

## 3. Retrieval — `query_system_model` rewrite

**File:** `server/system-model-tools/query-system-model.ts`, extending
`server/system-model/match.ts`.

### 3.1 Scoring all object types

`matchSystemModel` today scores only capabilities/flows. Extend `scoreObject`
to all five types with the same weight scheme, using per-type term sources:

| Type | name-weight (×3) source | keyword/aux (×2) | summary (×1) | file (×4) |
|---|---|---|---|---|
| capability | `name` | `keywords` | `summary` | `suggestedFiles` |
| flow | `name` | `steps` | `summary` | `suggestedFiles` |
| constraint | `statement` | `agentInstruction` | — | `appliesTo.files` |
| decision | `title` | — | `summary` | — |
| risk | — | — | `summary` | `appliesTo` (via linked caps/flows' files: skip in v1) |

### 3.2 Tool contract

- `query` **must be non-empty** unless `ids` is provided. Empty query with no
  ids → error result instructing the caller to pass a query, ids, or types.
- Results are the **topK scored matches** (default 5, hard cap 10 via a new
  optional `topK` input), each with `score` and `reasons`, rendered through
  the existing `per_object_summary` budget (250 tok) rather than as raw JSON
  dumps of full objects.
- `ids` lookups stay exact and unscored (that path is already precise).
- `objectTypes` remains a filter over the scored candidates.

### 3.3 Bounded link expansion

`expandLinked` currently returns *full linked objects* one hop out — through
hub nodes (`decision.graph_as_bus` is evidence for most constraints) this is
the amplification mechanism. Replace with **stubs**:

```ts
linked: Array<{ id: string; type: SystemModelObjectType; label: string }>
```

The leader fetches full linked objects on demand via `ids`. No full-object
transitive expansion anywhere in the query path.

### 3.4 Confidence + fallback

Reuse `matchConfidence` tiers from `match.ts`. A `low` result includes the
existing fallback instruction ("inspect repo; ask only if required") so the
leader does not retry with broader queries.

## 4. Applicability — gate & constraint rescoping

**Files:** `.systemmodel/policies/review-gates.yaml`,
`.systemmodel/constraints/*.yaml`, `server/system-model/validate.ts`.

### 4.1 Delete `gate.architecture_review`

The invariants it "guards" (file-size ceilings, cross-tree imports) are
already structurally enforced by `tests/architecture/*` in CI and the
pre-commit hook. A human review gate duplicating a deterministic CI check is
pure friction. **Delete the gate.** (User-approved 2026-07-06.)

Follow-ups the deletion forces:
- `constraint.no_cross_tree_imports.review_gate` → remove the field (its
  guard is `tests/architecture/no-cross-tree-imports.test.ts`, already listed
  in `suggested_tests`).
- Any validate.ts cross-reference check on gate ids must pass after removal.

### 4.2 Rescope repo-wide constraint globs to enforcement surfaces

| Constraint | Today | Redesign |
|---|---|---|
| `bus_only_broadcasts` (critical) | `files: [server/**/*.ts]` | `files: [server/bus.ts, server/ws-connection.ts, tests/architecture/no-direct-broadcast.test.ts]` |
| `no_cross_tree_imports` (high) | all of `server/**`, `src/**`, `shared/**` | `files: [shared/**/*.ts, tests/architecture/no-cross-tree-imports.test.ts]` |

Rationale: the CI test is the guard for the diffuse case ("any server file
might add a broadcast"); the model constraint should trigger context/packets
only where the *rule itself* or its enforcement is being changed. The
`agent_instruction` text still reaches any agent whose scoped capabilities
link the constraint — capability/flow linkage is untouched.

`gate.merge_review`, `gate.ws_contract_review`, `gate.system_model_review`
keep their current globs — they are already narrow, genuinely risky surfaces.

### 4.3 Overbreadth lint (regression guard)

New check in `validate.ts` (and surfaced by `model_health`, §6): for every
review gate and every constraint with non-empty `applies_to.files`, compute
glob coverage against tracked files (`git ls-files`, injected for testability).
Coverage **> 40%** of tracked source files → `ModelValidationError` of a new
`severity: "warning"` class (does not fail load; does fail
`pnpm system-model:validate` with `--strict`). This makes the defect class
this redesign fixes structurally non-reintroducible.

## 5. Structural packet trigger at plan/assign time

**Files:** `server/task-tools/` (plan/assign handlers), reusing
`derivePacketRequired`-style logic extracted from `compile.ts` into
`server/system-model/applicability.ts` (new, pure, colocated test).

- When the layer is active and `plan_task`/`assign_task` receives
  `files`/`ownedPaths`, the handler computes gate/critical-constraint glob
  intersection deterministically.
- **On hit:** the tool result carries a compact note —
  `systemModel: { gateHits: ["gate.merge_review"], packetRequired: true }` —
  and, for `assign_task` without a `workPacketId`, a one-line reminder to
  create/pass a packet. In `enforced` mode assign still proceeds
  (enforcement stays at the merge boundary, unchanged); this is *deterministic
  orientation replacing prompt orientation*.
- **On miss:** zero extra bytes in the tool result. Silence is the default.
- Tasks with no files/ownedPaths get no packet nag; the merge gate remains
  the backstop truth (it evaluates the actual diff).

## 6. Prompt injection — minimal conditional addendum

**File:** `server/agents/leader.ts` (`appendSystemModelAddendum`).

Replace the current always-on "use query_system_model for planning context"
block with a short factual addendum rendered from the loaded model:

```
## System Model
A system model is active. Gated surfaces (work packet required when a task
touches them): <rendered list of gate globs + critical-constraint globs>.
plan_task/assign_task will tell you when a task hits one. Tools:
query_system_model (scored, topK), create_work_packet, amend_work_packet,
check_freshness, record_verification.
```

- No instruction to query for general planning. Query is available, not
  mandated.
- After §4 rescoping the glob list is small; the existing 1200-token budget
  and truncation marker stay as the guard.

Minion-side injection is unchanged: Context Packs remain push-only via
`workPacketId`, already budgeted (2000 tok) in `compile.ts`.

## 7. Usage & health — trustworthy signals

**Files:** `server/system-model/store.ts`, `usage.ts`, `server/db.ts`,
`server/system-model-tools/{query-system-model,model-health}.ts`.

### 7.1 Attribution fix

`system_model_usage` gains columns (idempotent `ensureColumn` migration):

```sql
source       TEXT NOT NULL DEFAULT 'packet'   -- 'packet' | 'query'
session_key  TEXT                              -- leader session for query hits
```

- Packet compilation records `source='packet'`, `work_packet_id=<real id>`.
- Query hits record `source='query'`, `session_key=<leaderSessionKey>`,
  `work_packet_id=''` (never a fake join key again).
- Primary key widens to `(object_id, work_packet_id, source, session_key)`
  via table rebuild if needed — or keep PK and use `INSERT OR REPLACE`
  semantics per (object, session) for query hits.

### 7.2 `model_health` reads both signals

- "Unused" = no packet usage in last N packets **and** no query usage in the
  same time window. Reason strings distinguish the two.
- New report section **overbroad applicability** from the §4.3 lint, listing
  each offending gate/constraint with its coverage percentage.
- Existing stale/orphan checks unchanged.

## 8. What does NOT change

- Work Packet schema, compilation pipeline, context-pack budgets, amendment
  flow (`compile.ts` internals other than the extracted applicability helper).
- Merge-gate evaluation at the worktree boundary (`gates.ts`) — still
  diff-truth, still the only enforcement point.
- Reconciliation, seeding, WS commands, UI surfaces.
- `.systemmodel` capability/flow granularity (8 capabilities, 4 flows) —
  assessed as sound.

## 9. Testing

Per `docs/testing-strategy.md`, same-commit tests:

| Change | Tests |
|---|---|
| match.ts all-type scoring | extend `match.test.ts`: per-type term-source matrix, determinism, topK |
| query tool rewrite | `query-system-model.test.ts`: empty-query rejection, topK cap, stub-only linked, budget-rendered output, usage rows carry `source='query'` + real session key |
| YAML rescoping | `pnpm system-model:validate` green; `load.test.ts` fixture update if gate count is asserted |
| overbreadth lint | `validate.test.ts`: fixture model with 90%-coverage glob → warning; narrow glob → clean |
| plan/assign trigger | task-tools handler tests: hit → `systemModel` note present; miss → absent; no-files task → absent |
| addendum | `leader.test.ts`: addendum lists gate globs, omits "planning context" mandate, respects budget |
| usage/health | `store.test.ts` migration idempotence; `usage.test.ts` + `model-health.test.ts`: unused honors both sources; overbroad section renders |
| regression | bug test: query usage rows must join or carry session attribution — never orphaned fake packet ids |

## 10. Implementation decomposition

Disjoint-ownership tasks (parallel minions, isolated worktree, per repo
delegation policy):

| Task | Owns | Depends on |
|---|---|---|
| A. Retrieval rewrite | `server/system-model/match.ts`, `server/system-model-tools/query-system-model.ts` (+tests) | — |
| B. Applicability rescope + lint | `.systemmodel/**`, `server/system-model/validate.ts` (+tests) | — |
| C. Usage attribution + health | `server/db.ts` (usage table), `server/system-model/{store,usage}.ts`, `server/system-model-tools/model-health.ts` (+tests) | — |
| D. Structural trigger + addendum | `server/system-model/applicability.ts` (new), `server/task-tools/*` (plan/assign), `server/agents/leader.ts` (+tests) | A merges cleanly with C's store changes; D touches compile.ts only to extract the helper |

Integration order: A, B, C parallel → D → `pnpm verify` → worktree approval.
