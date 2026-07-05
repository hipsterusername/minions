# System Model Layer — Implementation Plan & Spec

Status: **implemented** (Phases 1–6, 2026-07-04) · Feature flag: `ProjectSettings.systemModel`

This document specifies the integration of an Agent Task Context Layer
("System Model") into Minions as an additive, feature-flagged capability.
It adapts the upstream ATCL handoff spec to Minions' architecture,
replacing the spec's generic mechanisms with minions-native equivalents
wherever the host already has a stronger primitive.

---

## 1. Goal and scope

Maintain a parallel **system model** — a compact, repo-versioned,
human-confirmed set of capabilities, flows, constraints, decisions, and
policies that captures *intent above the code* — and use it to:

1. Give the **leader** structured retrieval tools while it plans and
   decomposes work.
2. Compile a **Work Packet** per task: scoped context, constraints,
   non-goals, freshness verifications, and review-gate requirements.
3. Inject a **Context Pack** into every minion spawn touching gated
   surfaces.
4. **Gate merges** at the worktree boundary when policy demands review.
5. **Reconcile** merged diffs back into model-impact suggestions.

### 1.1 Non-goals (v0)

- No full codebase graph, no automatic architecture inference, no vector
  search, no runtime telemetry, no issue-tracker ingestion.
- No REST API — all surfaces are WS commands and MCP tools.
- No new approval system — gates attach to the existing worktree
  approval flow.
- No repo-committed generated artifacts (see §4.3 — deliberate deviation
  from the upstream spec).

### 1.2 Deviations from the upstream ATCL spec

| Upstream spec | This plan | Why |
|---|---|---|
| `stale_after: "7d"` wall-clock freshness | Git-derived freshness: model-file commit vs. last commit touching `suggested_files` globs | Wall-clock aging violates the spec's own §3.4; git history is cheap via `worktree-exec.ts` |
| `.systemmodel/generated/` committed to repo | Generated state (packets, reports, usage) in SQLite (`server/db.ts`) | Parallel worktrees would produce diff noise and merge conflicts on generated files |
| Keyword-scoring capability matcher (§25) | Deterministic scorer as candidate **pre-filter**; leader LLM does final matching inside `create_work_packet` | The planner is already a frontier model; a bespoke matcher would be worse and more code |
| Deterministic constraint verdicts in reconciliation | Deterministic file→capability→gate mapping; constraint **verdicts** produced by a reviewer minion | Static diff classification can't honestly output "appears_satisfied"; false assurance is worse than none |
| Prompt-mandated tool lifecycle (`createWorkPacket → … → reconcileRun`) | Structural enforcement at the merge boundary (`enforced` mode) + harness-side packet compilation | Prompt mandates get skipped under context pressure |
| `require_work_packet_for_agent_runs: true` globally | Packet **required** only when matched files/capabilities intersect gated globs; advisory otherwise | Risk-proportional friction; a global requirement trains users to disable the flag |
| Sidebar-navigation UI (§18) | Canvas node types + render-DSL components | Minions is an infinite canvas, not a page app |
| 18-state agent task state machine (§20) | Small extension of existing task/approval state | Most states already exist in `task-lifecycle.ts` / `ApprovalState` |
| HTTP routes (§21) | WS commands in `COMMAND_TABLE` + contract tests | Repo convention |
| No cold-start story | Model **seeding run**: minion fan-out drafts model files in a worktree; human approves the diff via the existing approval card | Solves the empty-model death spiral with machinery Minions already has |

---

## 2. Feature flag & activation

### 2.1 Setting

Add to `ProjectSettings` in `server/project-store.ts` (precedent:
`proactiveCompaction`):

```ts
/** System-model layer mode; see docs/system-model-implementation-plan.md. */
systemModel?: "off" | "advisory" | "enforced";
```

- `off` (default): zero behavior change. No tools registered, no prompt
  bytes injected, no gates evaluated, no DB tables touched.
- `advisory`: model loads, tools register, Context Packs inject, gate
  warnings surface on the approval card — nothing blocks.
- `enforced`: `blocks_merge` gates actually block merge commands until
  passed or explicitly waived by a human.

### 2.2 Activation predicate

The layer is **active** iff:

```
readSettings(projectPath).systemModel !== "off"
  && fs.existsSync(path.join(projectPath, ".systemmodel/manifest.yaml"))
```

`projectPath` is the sidecar root (`ctx.worktreeInfo?.projectPath ?? ctx.cwd`),
so settings resolution is stable even when the leader runs inside a
worktree. The **model files themselves** are read from the session's
`cwd` (the worktree), so each branch sees the model as of that branch —
model/code consistency per-branch for free.

### 2.3 Resolution lifecycle

Resolved **once per session start** inside `leader.getToolGroups()`
(same resolve-once discipline as `ProactiveCompactionState.settingResolved`).
A mid-session settings flip does not half-apply; it takes effect on the
next session.

```ts
export interface SystemModelRuntime {
  mode: "off" | "advisory" | "enforced";
  manifestFound: boolean;
  model: LoadedSystemModel | null;   // null when inactive or load failed
  loadErrors: ModelValidationError[]; // surfaced, never fatal to the session
}
```

Load failures **never** break session start: a malformed model file
degrades the layer to inactive for that session and emits a
`system_model_error` bus event so the UI can show the validation error
(upstream spec §32.1 error format).

---

## 3. Repo-side model format

Unchanged from the upstream spec except as noted. Human-authored only:

```
.systemmodel/
  manifest.yaml
  capabilities/*.yaml
  flows/*.yaml
  constraints/*.yaml
  decisions/ADR-*.md
  risks.yaml                # optional in v0
  policies/
    freshness.yaml
    review-gates.yaml
    context-budgets.yaml
```

Differences from upstream:

1. **No `generated/` section in the manifest.** Delete
   `generated.context_packs` etc. Generated state lives in SQLite (§4.3).
2. **Freshness fields** on capabilities/flows drop `stale_after`
   durations in favor of `class: code_coupled | policy | informational`.
   Staleness for `code_coupled` objects is *computed* (§6), never
   declared.
3. **`module_policy.require_work_packet_for_agent_runs` is removed.**
   Packet requirement is derived from gate-glob intersection (§7.4).
4. IDs stay stable-string (`capability.workspace_management`) per
   upstream §32.2. Generated objects use `wp_<timestamp>_<slug>` /
   `recon_<timestamp>_<slug>`.

### 3.1 Dependency note

The repo has **no YAML parser**. Add `yaml` (eemeli/yaml, actively
maintained, TS-native) as a dependency in Phase 1. Zod is already at
v4 — all schemas below are Zod v4.

---

## 4. Module layout & schemas

### 4.1 Shared schemas — `shared/system-model/`

Types cross the server/client boundary (graph UI, approval card gate
chips), and the architecture test forbids `server/ ↔ src/` imports, so
schemas live in `shared/`, following the `shared/render-dsl.ts`
precedent (Zod as single source of truth, discriminated unions on a
literal `type`/`kind` field):

```
shared/system-model/
  objects.ts      # capabilitySchema, flowSchema, constraintSchema,
                  # decisionMetaSchema, riskSchema + inferred types
  policies.ts     # freshnessPolicySchema, reviewGateSchema, contextBudgetSchema
  packet.ts       # workPacketSchema, requiredVerificationSchema,
                  # reviewGateRequirementSchema, packet lifecycle enum
  reconcile.ts    # reconciliationReportSchema, constraintCheckSchema,
                  # gateStatusSchema
  graph.ts        # SystemGraphNode / SystemGraphEdge wire format for the UI
  index.ts        # barrel
```

Representative shapes (abridged; full fields per upstream §8–§17 minus
the deviations in §1.2):

```ts
// shared/system-model/objects.ts
export const constraintSchema = z.object({
  id: z.string().regex(/^constraint\.[a-z0-9_]+$/),
  type: z.literal("constraint"),
  statement: z.string(),
  appliesTo: z.object({
    capabilities: z.array(z.string()).default([]),
    flows: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),      // globs
  }),
  severity: z.enum(["low", "medium", "high", "critical"]),
  agentInstruction: z.string().optional(),
  reviewGate: z.string().optional(),
  suggestedTests: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),      // decision ids
});
```

```ts
// shared/system-model/packet.ts
export const workPacketStatusSchema = z.enum([
  "draft", "active", "amended", "reconciled", "closed", "waived",
]);

export const workPacketSchema = z.object({
  id: z.string(),
  leaderSessionKey: z.string(),
  createdAt: z.number(),
  userRequest: z.string(),
  normalizedGoal: z.string(),
  status: workPacketStatusSchema,
  scope: z.object({
    capabilities: z.array(z.string()),
    flows: z.array(z.string()),
    constraints: z.array(z.string()),
    decisions: z.array(z.string()),
    risks: z.array(z.string()),
    suggestedFiles: z.array(z.string()),
    suggestedTests: z.array(z.string()),
  }),
  nonGoals: z.array(z.string()),
  agentInstructions: z.array(z.string()),
  freshness: z.object({
    status: z.enum(["fresh", "partially_stale", "stale_blocked", "unknown"]),
    warnings: z.array(z.string()),
    requiredVerifications: z.array(requiredVerificationSchema),
  }),
  reviewGates: z.array(reviewGateRequirementSchema),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  matchConfidence: z.enum(["high", "medium", "low"]),
  amendments: z.array(z.object({
    at: z.number(), reason: z.string(), delta: z.string(),
  })).default([]),
});
```

### 4.2 Server module — `server/system-model/`

Every file ≤ 400 lines (`tests/architecture/file-size.test.ts` applies
automatically to new `server/*.ts` files); each is pure-logic-first with
a colocated `*.test.ts`:

```
server/system-model/
  load.ts            # discover + parse .systemmodel/ from a cwd; YAML → zod
  load.test.ts
  validate.ts        # cross-reference integrity (linked_flows exist, gate ids
  validate.test.ts   #   resolve, glob syntax valid) → ModelValidationError[]
  freshness.ts       # git-derived staleness (§6); pure given commit timestamps
  freshness.test.ts
  match.ts           # deterministic candidate scorer (§7.2 pre-filter)
  match.test.ts
  compile.ts         # WorkPacket + Context Pack assembly from matched scope
  compile.test.ts
  gates.ts           # evaluateGates(diff, model) → ReviewGateRequirement[];
  gates.test.ts      #   evaluateMergeGates(host) → MergeGateVerdict (§8)
  reconcile.ts       # deterministic diff→capability/constraint/test mapping
  reconcile.test.ts
  store.ts           # SQLite persistence for packets/reports/usage (§4.3)
  store.test.ts
  runtime.ts         # SystemModelRuntime resolution (§2.3); flag + manifest
  runtime.test.ts
  graph.ts           # LoadedSystemModel → SystemGraphNode/Edge wire format
  graph.test.ts
```

Git access goes exclusively through the existing
`server/worktree-exec.ts` `exec(args, cwd)` helper — no new process
spawning surface.

### 4.3 Persistence — new tables in `server/db.ts`

Added to `initDb()` (idempotent `CREATE TABLE IF NOT EXISTS`, matching
existing style; future migrations via `ensureColumn`):

```sql
CREATE TABLE IF NOT EXISTS work_packets (
  id                  TEXT PRIMARY KEY,
  leader_session_key  TEXT NOT NULL,
  status              TEXT NOT NULL,             -- workPacketStatusSchema
  risk_level          TEXT NOT NULL,
  user_request        TEXT NOT NULL,
  packet_json         TEXT NOT NULL,             -- full workPacketSchema doc
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_packets_session
  ON work_packets(leader_session_key);

CREATE TABLE IF NOT EXISTS work_packet_verifications (
  work_packet_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- requiredVerificationSchema.kind
  target          TEXT NOT NULL,
  result          TEXT NOT NULL,                 -- passed|failed|not_run|unknown
  notes           TEXT,
  recorded_at     INTEGER NOT NULL,
  PRIMARY KEY (work_packet_id, kind, target)
);

CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id              TEXT PRIMARY KEY,
  work_packet_id  TEXT NOT NULL,
  report_json     TEXT NOT NULL,                 -- reconciliationReportSchema doc
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_model_usage (
  object_id       TEXT NOT NULL,                 -- capability.x / constraint.y
  work_packet_id  TEXT NOT NULL,
  used_at         INTEGER NOT NULL,
  PRIMARY KEY (object_id, work_packet_id)
);
```

`system_model_usage` makes the Phase 5 bloat guard a single query
("objects unused in last N packets").

---

## 5. Agent tool surface

### 5.1 Leader tools — new MCP group `"system-model"`

New factory directory `server/system-model-tools/` mirroring
`server/task-tools/` (one file per tool, `NormalizedToolDef` with Zod
`inputSchema`, `okResult`/`textResult`/`errorResult`). Registered in
`leader.getToolGroups()` **only when `SystemModelRuntime.mode !== "off"`**:

```ts
// server/agents/leader.ts (getToolGroups)
const smRuntime = resolveSystemModelRuntime(ctx);      // §2.3
const toolGroups: Record<string, NormalizedToolDef[]> = {
  "task-manager": taskDefs,
  "render-dashboard": renderDefs,
  ...(smRuntime.mode !== "off" && smRuntime.model
    ? { "system-model": createSystemModelToolsForLeader({ ctx, runtime: smRuntime }) }
    : {}),
};
```

Fully-qualified names (`mcp__system-model__*`) flow into `allowedTools`
automatically via the `derivedMcpToolNames` flattening in
`buildHarnessStartOpts` — no harness changes needed.

| Tool | Purpose | Notes |
|---|---|---|
| `query_system_model` | Pull-based retrieval during planning: `{ query, objectTypes?, ids? }` → matching objects with linked-object expansion | Records hits in `system_model_usage` |
| `create_work_packet` | `{ userRequest, taskIds? }` → compiled WorkPacket + Context Pack markdown | LLM-assisted matching (§7.2); returns pack inline — no separate `getContextPack` tool |
| `amend_work_packet` | `{ workPacketId, reason, scopeDelta }` → recompiled packet, gates re-evaluated | Supports iterative replanning (upstream gap); amendment logged for reconciliation |
| `check_freshness` | `{ objectIds?, files? }` → git-derived freshness report | Cheap; leader may call ad hoc mid-plan |
| `record_verification` | `{ workPacketId, kind, target, result, notes? }` | Persists to `work_packet_verifications`; satisfies `RequiredVerification` items |
| `reconcile_run` | `{ workPacketId, agentSummary }` → deterministic report + (when constraints in scope) a ready-made reviewer-minion task description | §9 |
| `record_constraint_verdicts` | `{ workPacketId, verdicts: ConstraintCheck[] }` | Leader relays the reviewer minion's structured `report_done` output |

Tool count is deliberately higher than upstream's 7 only because
`amend_work_packet` and `record_constraint_verdicts` close real gaps
(iterative planning; honest verdicts). `getContextPack` and
`getSystemModelStatus` from upstream are folded into `create_work_packet`
and the WS status command respectively.

### 5.2 Minions get push, not tools

Minions stay narrow. The Context Pack is injected into the spawn prompt,
not offered as tools:

1. `create_work_packet` links packets to `taskIds`. `assign_task`'s
   handler looks up an active packet covering the task (or the leader
   passes `workPacketId` — add an optional field to
   `assignTaskInputSchema`).
2. `buildTaskSpawnPrompt` (`server/task-tools/task-prompt.ts`) gains an
   optional `contextPack?: string` parameter rendered as a
   `## System Model Context` section — after the existing
   worktree/skills sections, before the task description. In the minion
   system prompt's section order it lands where per-task context
   naturally slots: after `## Project Context`, before `## Guidelines`.
3. The pack always carries the upstream §32.4 safety preamble verbatim:
   *"Suggested files are hints, not truth. Inspect current code before
   editing. Hard constraints override implementation convenience. If
   current code contradicts this context, report the conflict."*

### 5.3 Context budgets

`policies/context-budgets.yaml` gets a real schema
(`shared/system-model/policies.ts`):

```yaml
context_budgets:
  leader_prompt_addendum: 1200   # tokens, approximate (chars/4)
  minion_context_pack: 2000
  per_object_summary: 250
```

`compile.ts` enforces budgets at pack-render time: objects are included
in priority order (constraints → decisions → flows → capability summary
→ suggested files/tests) and truncated with an explicit
`[N objects omitted by context budget — use query_system_model]` marker.
Silent truncation is forbidden (upstream "no silent caps" principle).

### 5.4 Leader system prompt addendum

When active, `buildSystemPrompt` appends a short (budgeted, §5.3)
addendum after the base leader prompt describing: the system-model tool
group, when a Work Packet is **required** (gated-surface tasks, §7.4),
and the amend-on-replan rule. This is orientation only — enforcement is
structural (§8), never prompt-only.

---

## 6. Freshness (git-derived)

For a `code_coupled` object, staleness compares two commit timestamps,
both obtained via `worktree-exec.ts` from the session `cwd`:

```
modelTouchedAt = git log -1 --format=%ct -- .systemmodel/<object file>
codeTouchedAt  = max over suggested_files globs of
                 git log -1 --format=%ct -- <glob>
stale ⇔ codeTouchedAt > modelTouchedAt
```

- `freshness.ts` is pure given `{ objectFile, globs } → timestamps`;
  the git shell-out is injected, so unit tests need no repository.
- Results are cached per `(cwd, HEAD sha)` for the session — one git
  call per object file per HEAD, not per query.
- `policies/freshness.yaml` maps *policy classes* (permission_sensitive,
  billing_sensitive, ordinary) to **consequences** exactly as upstream
  §13: `verify_before_task`, `required_agent_actions`,
  `block_if_unverified`. Only the *trigger* changes from wall-clock to
  git-derived.
- `block_if_unverified` in `enforced` mode: `create_work_packet` returns
  `freshness.status: "stale_blocked"` and the packet cannot move to
  `active` until the matching `record_verification` rows exist. In
  `advisory` mode the same condition is a warning.

---

## 7. Work Packet compilation

### 7.1 Pipeline

```
userRequest (+ optional taskIds)
  → match.ts scorer → top-K candidate capabilities/flows (deterministic)
  → LLM-assisted selection (the leader itself, via the tool round-trip)
  → linked-object expansion (flows, constraints, decisions, risks)
  → freshness check (§6)
  → gate evaluation over suggestedFiles ∪ task.files globs (gates.ts)
  → budgeted Context Pack render (§5.3)
  → persist (work_packets) + return
```

### 7.2 Matching

`match.ts` implements upstream §25's scorer **as a pre-filter only**
(name/flow/file/keyword hits → top-K candidates with reasons). The
`create_work_packet` tool description instructs the leader to confirm or
correct the candidate set — the LLM in the loop is the semantic matcher.
Low-confidence results set `matchConfidence: "low"` and include the
upstream fallback instruction ("inspect repo; ask only if required")
instead of blocking.

### 7.3 Amendment

Leaders replan. `amend_work_packet` recompiles scope/freshness/gates
from a scope delta and appends to `amendments[]`. Reconciliation (§9)
reads the *final* amended scope. A packet is never silently regenerated —
each amendment carries a reason string that surfaces in the approval UI.

### 7.4 When a packet is required

Derived, not configured: a packet is **required** for a task iff the
task's `files`/`ownedPaths` (or, absent those, the matched capabilities'
`suggested_files`) intersect any `review_gates.required_when.files` glob
or any `severity: critical` constraint's `applies_to.files` glob.
Routine tasks proceed packet-less in both advisory and enforced modes;
`enforced` only refuses **merge** (never session start) for gated
changes lacking a reconciled packet — see §8.

---

## 8. Merge gating (the enforcement boundary)

### 8.1 The bypass problem

Merge paths today: `approve_changes`, `force_merge`, `theirs_merge`,
`retry_merge` (all via `runMergeFlow`), **and `merge_worktree`, which
calls `mergeAndCleanup()` directly.** A gate patched only into
`runMergeFlow` would be bypassable. Therefore:

### 8.2 Central guard

```ts
// server/system-model/gates.ts
export interface MergeGateVerdict {
  allowed: boolean;
  mode: "off" | "advisory" | "enforced";
  gates: Array<{
    id: string;
    name: string;
    status: "not_required" | "required_pending" | "passed" | "failed" | "waived";
    reason: string;
  }>;
}

export async function evaluateMergeGates(host: SessionHost): Promise<MergeGateVerdict>;
```

Evaluated against the **actual diff** (`getDetailedDiff(host.worktree)`),
not the packet's predicted scope — the agent may have touched files
outside prediction; the diff is truth. Gate status resolves from:
required_when glob hits × reconciliation report existence × verification
rows × waivers.

Call sites: `runMergeFlow` (first statement) **and**
`merge-worktree.ts` before `mergeAndCleanup`. In `advisory` mode a
failing verdict emits `merge_gate_warning` on the bus and proceeds; in
`enforced` mode the command replies with a control error carrying the
verdict and emits `merge_blocked_by_gate`.

### 8.3 Waiver

New WS command `waive_review_gate`
(`{ sessionKey, gateId, reason }`) — a human action from the approval
card. Waivers persist into the packet (`status: "waived"`, with reason
and timestamp) and appear in the reconciliation report. There is no
agent-callable waiver.

### 8.4 Architecture test

New `tests/architecture/merge-gate.test.ts`, same grep-based style as
`no-direct-broadcast.test.ts`: **every command file that references
`mergeAndCleanup` or `runMergeFlow` must also reference
`evaluateMergeGates`.** This makes future merge commands
gate-safe by construction.

### 8.5 Approval-state extension

`ApprovalState` (`server/task-tools/types.ts`) gains:

```ts
/** System-model gate verdict at approval-request time (null when layer off). */
gates?: MergeGateVerdict | null;
```

`request-approval.ts` populates it so the `approval_requested` event
carries gate chips to the UI with zero extra round-trips.

---

## 9. Reconciliation

Two layers, honestly separated:

**Deterministic (`reconcile.ts`)** — pure given diff + model:
- changed files → affected capabilities/flows (glob mapping)
- constraints in scope → gate requirements re-derived from the real diff
- `suggested_tests` vs. changed/verified tests → `testsMissing`
- packet scope vs. diff → out-of-scope file list (scope-drift signal)

**Agentic (reviewer minion)** — verdicts:
- `reconcile_run` returns the deterministic report plus, when
  constraints are in scope, a generated reviewer task description
  (constraint statements + agent_instructions + diff summary + suggested
  tests + required output format: JSON `ConstraintCheck[]` with
  `status ∈ appears_satisfied | possibly_violated | violated | not_checked`
  and evidence).
- The leader assigns it via ordinary `assign_task` (a read-only review
  task; no code edits, so no ownership-boundary risk). The reviewer
  reports via `report_done` with the JSON payload; the leader relays it
  through `record_constraint_verdicts`.
- Reports are labeled by provenance: deterministic fields vs.
  minion-judged verdicts are distinct in the schema and the UI. No
  deterministic code ever emits "appears_satisfied".

The assembled `ReconciliationReport` (upstream §17 shape, plus
`outOfScopeFiles` and `provenance`) persists to
`reconciliation_reports` and flips the packet to `reconciled`, which is
what `evaluateMergeGates` checks in `enforced` mode.

Timing: reconciliation runs at **approval-request time** (the leader's
`request_approval` flow prompts it when gates are pending), so the human
sees gate status + verdicts on the approval card before deciding.

---

## 10. WS commands & bus events

New `WsCommandType` members (handlers in `server/commands/<name>.ts`,
entries in `COMMAND_TABLE` — the `satisfies CommandTable` check enforces
completeness; validation added to `server/commands/schemas.ts`):

| Command | Purpose |
|---|---|
| `get_system_model_status` | `{ enabled, mode, manifestFound, counts, loadErrors }` |
| `get_system_graph` | `SystemGraphNode[]/Edge[]` wire format for the UI (from `graph.ts`), with freshness/risk annotations |
| `get_work_packets` | List/detail packets for a session or project |
| `waive_review_gate` | §8.3 — human-only gate waiver |

New bus payload types (all emitted through `Bus`, never direct
broadcast): `system_model_error`, `work_packet_created`,
`work_packet_amended`, `merge_gate_warning`, `merge_blocked_by_gate`,
`reconciliation_ready`.

Each new command gets a contract test in `tests/contracts/` following
`ws-command-validation.test.ts` (valid payload dispatches unchanged;
malformed payload → error reply, no dispatch).

---

## 11. UI

All client work is additive node types / component usage — **zero
changes to `Canvas.tsx`, `LeaderNode.tsx` internals beyond ConfigFooter,
or the render-DSL schema** in v0.

### 11.1 Approval card gate chips — `ConfigFooter.tsx`

The approval panel already renders summary + diff stats. Add a gate
strip driven by `approvalDiff`-adjacent data (`ApprovalState.gates` via
the `approval_requested` event): one chip per gate
(`passed ✓ / pending ⚠ / failed ✕ / waived ~`), expandable to reasons
and verification status, with a **Waive** button (sends
`waive_review_gate`; disabled in advisory mode where gates are
informational). ConfigFooter is 650 lines and on the keep-small watch
list — the gate strip is a new extracted component
(`src/nodes/leader/GateStrip.tsx`), not inline growth.

### 11.2 System Graph — new canvas node type

`src/nodes/SystemGraphNode.tsx`, registered via `registerNodeType`:

```ts
registerNodeType({
  type: "system-graph",
  label: "System Model",
  defaultSize: { width: 640, height: 480 },
  render: SystemGraphNodeRenderer,
  userCreatable: true,
});
```

- Fetches via `get_system_graph`; renders capability → flow → file-area
  hierarchy as SVG (the canvas already hand-renders bezier edges; no
  graph library is added in v0 — dagre or similar only if hand layout
  proves painful, decided in Phase 5).
- Node inspector panel per upstream §18.4, answering "why does this
  matter for agent execution" (constraints, gates, freshness, active
  packets touching it).
- Filters: by risk, by freshness, by active work packet.

### 11.3 Work Packet & Model Impact — render DSL, no new components

The existing DSL already covers both surfaces:

- **Packet review**: leader renders the compiled packet as
  `section`(scope)/`checklist`(verifications)/`callout`(freshness
  warnings)/`tags`(gates), with a `form` for edit-or-approve when
  `matchConfidence: "low"` or `riskLevel ≥ high`. Form answers return as
  a user turn → leader calls `amend_work_packet`.
- **Model Impact** (post-reconciliation): `table`(affected objects),
  `callout`(suggested model updates), `diff` where a concrete YAML edit
  is proposed.

The leader-prompt addendum (§5.4) tells the leader to render these at
the appropriate moments; `request_approval`'s existing "must render
dashboard" rule extends to include gate status.

### 11.4 Later (post-v0, explicitly deferred)

**Model objects as canvas context nodes**: a `capability` node type
(`providesContext: true`, `extractContent` → the capability's Context
Pack fragment) wired into a leader's context-in port — the user
physically pins "Workspace Management" to scope a session. This is the
most minions-native expression of the feature (graph-as-bus doing scope
selection) and should be revisited once packet compilation is proven.

---

## 12. Model seeding (cold start)

The empty-model death spiral is solved with a **seeding run** that uses
only existing machinery:

1. User enables the flag and clicks "Seed system model" (or prompts the
   leader). A leader session starts **with worktree isolation on**.
2. Leader fans out read-only exploration minions per subsystem
   (`assign_task` with explicit ownership boundaries: each minion may
   write only its own draft files under `.systemmodel/`), armed with a
   `system-model-authoring` skill (added to the project skill library)
   that encodes the object schemas, the bloat-guard creation rules
   (upstream §26.1), and the "capabilities are user-facing powers, not
   modules" discipline.
3. Drafts land as ordinary file changes in the worktree. The **diff is
   the model** — the human reviews and prunes via the existing approval
   card and merges. No new approval surface, no new write path.
4. `validate.ts` runs as part of the seeding leader's acceptance
   criteria (`pnpm` script `system-model:validate`, also usable in CI).

This delivers the upstream 80/15/5 maintenance ratio's "80% generated"
leg on day one. The same pattern serves ongoing model updates suggested
by reconciliation reports.

---

## 13. Testing plan

Per the working agreement (`docs/testing-strategy.md`), tests ship in
the same commit as each behavior:

| Layer | Tests |
|---|---|
| `shared/system-model/*` | Colocated schema tests: valid/invalid fixtures per object type; budget math |
| `server/system-model/load.ts` | Fixture `.systemmodel/` trees (valid, malformed YAML, dangling refs) → parsed model / precise `ModelValidationError`s |
| `freshness.ts` | Injected timestamp fn; stale/fresh/unknown matrix; policy-class consequence mapping |
| `match.ts` | Scorer determinism, top-K, reason strings, low-confidence path |
| `compile.ts` | Scope expansion, budget truncation markers, safety preamble always present, packet-required derivation (§7.4) |
| `gates.ts` | Glob-hit matrix × mode × reconciliation/waiver state → verdicts; the `merge_worktree` and `runMergeFlow` call sites each covered |
| `reconcile.ts` | Diff fixtures → affected-object mapping, testsMissing, out-of-scope detection; asserts deterministic layer never emits verdict statuses |
| `store.ts` | Round-trip persistence; usage-counter queries |
| Tools | Handler tests per tool file (Zod rejection, state mutation, bus emissions) — same style as existing `task-tools` tests |
| WS commands | `tests/contracts/` per new command (dispatch + rejection) |
| Architecture | `merge-gate.test.ts` (§8.4); file-size and cross-tree-import tests apply automatically |
| UI | Component tests for `GateStrip` (chip states, waive send) and `SystemGraphNode` (fetch → render, filter behavior) via `@testing-library/react`, `waitFor` not timeouts |

Bug-regression and refactor-arrow rules apply as usual. `pnpm verify`
green is the bar for every phase.

---

## 14. Phasing

Each phase is independently shippable and flag-gated; **nothing blocks
until Phase 5**.

### Phase 1 — Model core + read-only retrieval
- `yaml` dependency; `shared/system-model/`; `load.ts`, `validate.ts`,
  `runtime.ts`, `graph.ts`, `store.ts` (tables only).
- Flag in `ProjectSettings`; `query_system_model` tool;
  `get_system_model_status` + `get_system_graph` commands.
- `pnpm system-model:validate` script.
- **Accept:** flag off ⇒ byte-identical behavior (assert: no
  `system-model` tool group registered, no prompt delta). Flag on +
  fixture model ⇒ leader can query; malformed model degrades gracefully
  with visible errors.

### Phase 2 — Seeding
- `system-model-authoring` skill; seeding leader flow (§12); docs.
- **Accept:** seeding run on this repo produces a reviewable
  `.systemmodel/` diff that passes `validate.ts`; human merges via the
  normal approval card.

### Phase 3 — Packet compiler + Context Pack injection
- `match.ts`, `compile.ts`, `freshness.ts`; `create_work_packet`,
  `amend_work_packet`, `check_freshness`, `record_verification`;
  `buildTaskSpawnPrompt` contextPack param; `workPacketId` on
  `assign_task`; leader prompt addendum; budgets.
- **Accept:** gated-surface request ⇒ packet with correct
  constraints/gates/verifications; minion spawn prompt contains the
  budgeted pack with safety preamble; replanning amends rather than
  regenerates.

### Phase 4 — Advisory gates + reconciliation
- `gates.ts` + both merge-path call sites (warning-only);
  `ApprovalState.gates`; `GateStrip`; `reconcile_run`,
  `record_constraint_verdicts`; reviewer-minion flow; Model Impact
  rendering; `merge-gate.test.ts`.
- **Accept:** approval card shows gate chips with honest provenance;
  reconciliation report persists; advisory mode never blocks anything.

### Phase 5 — Enforced mode
- `enforced` blocking in both merge paths; `waive_review_gate` command +
  UI; `stale_blocked` packet state; contract tests for the block/waive
  paths.
- **Accept:** enforced + failing gate ⇒ every merge command (including
  `merge_worktree`, `force_merge`, `theirs_merge`) refuses with the
  verdict; waiver unblocks with an audit trail; advisory projects see
  zero behavioral change.

### Phase 6 — Bloat guard + graph UI polish
- Usage/staleness/orphan queries over `system_model_usage`; prune
  recommendations surfaced via render DSL; `SystemGraphNode` filters and
  inspector; (optional) capability-as-context-node spike (§11.4).
- **Accept:** "unused in last 30 packets" and "stale objects" lists are
  accurate against fixtures; model health renders on demand.

---

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Layer becomes friction → users flag off | Risk-scoped packet requirement (§7.4); advisory-first phasing; budgets keep prompt cost bounded |
| Gate bypass via future merge commands | Architecture test (§8.4) makes the guard structural |
| Stale/false model misleads agents | Git-derived freshness; safety preamble in every pack; "hints, not truth" discipline; reconciliation flags scope drift |
| Model rot | Bloat guard queries (Phase 6); seeding pattern reused for updates; reconciliation suggests concrete edits |
| Server file-size ceilings | Module pre-split into ~13 small files; tools one-per-file |
| Concurrent leaders on one project | Packets keyed by session; gates evaluate each worktree's own diff; reconciliation runs against the diff at approval time, not global state |
| YAML parse cost per session | Model loaded once per session start, cached on `(cwd, HEAD)` |

## 16. Open questions

1. Should `advisory` be the default once a manifest exists (flag
   default flips from `off` → `advisory` when `.systemmodel/` is
   present)? Current answer: no — explicit opt-in per project.
2. Reviewer-minion model tier: default `reasoning` executor class for
   constraint verdicts, or inherit project default?
3. Should reconciliation reports optionally export as markdown artifacts
   into the worktree for PR bodies (opt-in, since §4.3 argues against
   repo-side generated files)?
4. Multi-repo / monorepo: one `.systemmodel/` at project root only in
   v0, or support nested manifests? (v0: root only.)
