# Unified leader/work-item lifecycle implementation plan

## Purpose

Activity, Canvas, and Kanban currently infer the state of the same work from
different records. This plan introduces one durable work item, immutable run
records, and shared selectors so repeated user iterations and both editing
modes have one lifecycle everywhere.

The durable identity is called `workItemId` in storage and APIs. Product copy
may call it a leader. `leaderId` must not become a second independently stored
identifier. A canvas node, a Kanban card, and a harness session are bindings or
runs of the work item, not the work item itself.

## Current-state audit

The implementation already contains several primitives worth preserving:

- `sessions.session_key` owns runtime status, harness metadata, task state,
  render state, usage, review fields, and per-session worktree metadata.
- `SessionHost.start()` deliberately reuses a long-lived host and currently
  calls `beginRun()` on every follow-up, overwriting the session-level terminal
  projection. This loses immutable per-iteration outcomes.
- `NormalizedEvent` provides structured `tool_call`, `tool_result`, and `done`
  events. It does not include `workItemId`, paths in a normalized shape, or a
  guaranteed pre-execution interception point.
- Activity reads `session_list` and `session_lifecycle_changed`; its durable
  review lifecycle is the closest existing model to the target.
- Canvas persists `LeaderData.status` and worktree presentation fields inside
  node JSON. These are client projections and can be stale after reload.
- Kanban is project-local browser `localStorage`. Cards bind through
  `leaderNodeId`, infer completion from canvas status, and may be deleted when
  a leader node disappears.
- Worktrees are named and owned by `sessionKey`. Minions may inherit the same
  `WorktreeInfo`, but independent leaders cannot join a durable lineage.
- `beginWorktreeOperation()` is a process-local, per-`SessionHost` `WeakMap`
  lock. It does not serialize two sessions targeting the same Git ref and does
  not survive restart.
- `mergeWorktree()` has valuable Git safety properties: it checks a dirty main
  checkout, integrates target changes away from the main worktree, and uses
  `git update-ref <new> <old>` as a compare-and-set.
- `event_log` is explicitly a short replay buffer, not durable history. It
  cannot be the source of run or work-item state.

The target keeps normalized terminal events, review CAS revisions, Git ref
CAS, dirty-checking, session persistence, and project-scoped bus delivery. It
replaces cross-surface inference and session-owned worktree policy.

## Canonical model

### Work-item dimensions

```ts
type RuntimeState = "draft" | "starting" | "working" | "waiting" | "inactive";
type Outcome = "none" | "completed" | "error" | "interrupted";
type Resolution = "open" | "reviewed" | "archived";
type ChangeMode = "live" | "worktree";

type IntegrationState =
  // live mode
  | "live_clean" | "live_editing" | "live_conflict_wait"
  // worktree mode
  | "worktree_unprovisioned" | "worktree_active"
  | "worktree_queued" | "worktree_integrating" | "worktree_conflicted"
  | "worktree_integrated" | "worktree_discarded";
```

The dimensions answer separate questions:

- runtime: is an agent doing anything now?
- outcome: how did the latest terminal run end?
- resolution: has the user reviewed or archived that outcome?
- change mode: where are changes made?
- integration: are changes actively coordinated or merged?
- workflow placement: where did the user put the item on Kanban?

Kanban `columnId` is therefore not a lifecycle field. Waiting, error, and
review badges are projections over canonical state even if the card remains in
a user-selected column.

### Persistence

Add the following tables to the global server persistence database beside
`sessions`. This placement is required because reopening a work item and
inserting its next run must commit in one SQLite transaction. Canvas projects
currently live in separate per-project sidecars, so `project_id` is a stable
cross-database reference rather than a SQLite foreign key. Existing `sessions`
rows remain the run snapshots to minimize migration and preserve their current
relationships.

```sql
CREATE TABLE work_items (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  project_path          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  runtime_state         TEXT NOT NULL,
  outcome               TEXT NOT NULL,
  resolution            TEXT NOT NULL,
  change_mode           TEXT NOT NULL,
  integration_state     TEXT NOT NULL,
  current_run_key       TEXT,
  iteration             INTEGER NOT NULL DEFAULT 0,
  workflow_column_id    TEXT NOT NULL DEFAULT 'backlog',
  workflow_rank         TEXT NOT NULL,
  lifecycle_revision    INTEGER NOT NULL DEFAULT 0,
  last_transition_at    INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE work_item_bindings (
  work_item_id          TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  surface               TEXT NOT NULL, -- canvas | kanban
  binding_id            TEXT NOT NULL, -- node id or card id
  attached_at           INTEGER NOT NULL,
  detached_at           INTEGER,
  PRIMARY KEY (work_item_id, surface, binding_id)
);

ALTER TABLE sessions ADD COLUMN work_item_id TEXT REFERENCES work_items(id);
ALTER TABLE sessions ADD COLUMN run_number INTEGER;
ALTER TABLE sessions ADD COLUMN previous_run_key TEXT;
ALTER TABLE sessions ADD COLUMN started_at INTEGER;
ALTER TABLE sessions ADD COLUMN ended_at INTEGER;
ALTER TABLE sessions ADD COLUMN run_outcome TEXT NOT NULL DEFAULT 'none';
ALTER TABLE sessions ADD COLUMN final_report_event_id TEXT;
```

`sessions.session_id` remains the provider/harness thread ID. It may be copied
forward as `resumeId` to preserve conversational context. It is not a run ID.
`sessions.session_key` is generated once for each run and never reused.
Reuse the existing session review/report and `final_dashboard_revision`
columns as the terminal run snapshot during migration; do not add duplicate
columns with new names.

Terminal run fields are append-only after `ended_at` is set. Item fields are a
transactional projection of the current run and may reopen on a new iteration.
Usage, messages, task records, dashboard snapshots, and events remain keyed to
the immutable run. Aggregate selectors sum or choose among those runs.

Canvas node removal only sets `work_item_bindings.detached_at`; it must not
delete the work item or its runs. Archiving a work item does not require
removing either surface binding. A separate explicit destructive command may
purge a work item and must use normal confirmation and foreign-key cleanup.

### Optional change-lineage persistence

Worktree mode moves ownership from a session row to a durable lineage and
contribution:

```sql
CREATE TABLE change_lineages (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  repository_path       TEXT NOT NULL,
  target_branch         TEXT NOT NULL,
  integration_branch    TEXT NOT NULL,
  target_sha_at_open    TEXT NOT NULL,
  integration_head_sha  TEXT NOT NULL,
  state                 TEXT NOT NULL, -- open | integrating | conflicted | integrated | abandoned
  revision              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE change_contributions (
  id                    TEXT PRIMARY KEY,
  lineage_id            TEXT NOT NULL REFERENCES change_lineages(id),
  work_item_id          TEXT NOT NULL REFERENCES work_items(id),
  run_key               TEXT NOT NULL REFERENCES sessions(session_key),
  branch                TEXT NOT NULL UNIQUE,
  worktree_path         TEXT NOT NULL UNIQUE,
  base_sha              TEXT NOT NULL,
  head_sha              TEXT,
  state                 TEXT NOT NULL, -- active | review | queued | integrating | conflicted | integrated | discarded
  revision              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE merge_queue (
  id                    TEXT PRIMARY KEY,
  repository_path       TEXT NOT NULL,
  target_ref            TEXT NOT NULL,
  lineage_id            TEXT NOT NULL REFERENCES change_lineages(id),
  contribution_id       TEXT REFERENCES change_contributions(id),
  operation             TEXT NOT NULL, -- integrate_contribution | promote_lineage
  state                 TEXT NOT NULL, -- queued | running | conflicted | succeeded | failed | cancelled
  sequence              INTEGER NOT NULL,
  expected_target_sha   TEXT,
  fencing_token         INTEGER,
  attempts              INTEGER NOT NULL DEFAULT 0,
  error_json            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
```

Only one `running` queue entry may exist for `(repository_path, target_ref)`.
Acquire it in a database transaction with a monotonically increasing fencing
token. Git `update-ref` remains the final authority: a stale expected SHA must
return the entry to `queued` for a fresh rebase/integration attempt, never
overwrite the newer ref.

## State machines and transitions

### Work-item transition table

| Trigger | Preconditions | Atomic item transition | Run action |
| --- | --- | --- | --- |
| Create draft | no item | `draft, none, open` | none |
| Start first iteration | draft/inactive | `starting, none, open` | insert run 1 |
| Harness init | current run starting | `working` | record harness thread ID |
| Structured input/temporary wait | current run working | `waiting, none, open` | keep run open |
| Reply/resume wait | current run waiting | `starting` then `working` | resume same open run |
| Successful `done` with persisted final report | current run open | `inactive, completed, open` | seal run completed |
| Terminal error | current run open | `inactive, error, open` | seal run error |
| Abort, process loss, or completion without report | current run open | `inactive, interrupted, open` | seal run interrupted |
| User reviews outcome | terminal outcome, open | `resolution:reviewed` | none |
| User archives | inactive | `resolution:archived` | none |
| User sends a new iteration | current run terminal | `starting, none, open`; increment iteration | insert a new run and link previous run |
| User retries interrupted/error run | current run terminal | same reopen transition | insert a new run |

The start/new-iteration transaction must compare `lifecycle_revision`, insert
the run, assign `current_run_key`, clear the item outcome, reopen resolution,
increment `iteration` and revision, and commit before launching a harness. If
launch fails, seal that newly created run as error and project the error back
to the item. Duplicate commands with the same idempotency key return the same
run key.

`completed + reviewed` is the normal happy path. `archived` only controls
visibility; it never erases `completed`, `error`, or `interrupted` history.

### Legality and recovery invariants

- `runtime_state != inactive` implies `outcome = none`.
- `outcome != none` implies `runtime_state = inactive` and a sealed current
  run with the same outcome.
- `resolution = reviewed` requires a terminal outcome; `archived` requires a
  draft or inactive item so never-started backlog work can be removed without
  inventing a run outcome.
- `current_run_key`, when present, belongs to the same work item and has the
  largest `run_number`.
- A terminal run never becomes non-terminal and never changes outcome.
- At most one unsealed run exists per work item.
- Boot recovery seals every `starting`, `working`, or `waiting` run without a
  live harness as interrupted exactly once. Existing terminal outcomes remain
  unchanged.
- A stale canvas snapshot or browser-local Kanban value cannot write canonical
  lifecycle fields.

## Live shared-file coordination

Use both explicit intents and short advisory leases. An intent supplies early
awareness while an agent is directly considering a change; the lease is the
server-side serialization primitive at mutation time.

### Protocol

1. The agent calls `open_change_intent(paths, reason)` immediately before
   focused investigation/editing. Paths are project-relative and may be files
   or directory prefixes.
2. The coordinator canonicalizes paths, rejects traversal/symlink escapes, and
   atomically checks the entire sorted path set. Overlap means the same file or
   an ancestor/descendant prefix.
3. If available, it grants a renewable lease and broadcasts the intent. If a
   conflicting writer exists, the run becomes `waiting` with a structured
   `file_conflict` reason. The request joins a FIFO queue.
4. A harness `beforeMutation` hook must acquire or validate the lease before
   executing `Write`, `Edit`, patch application, delete, rename, or a Codex
   file change. Multi-path claims are all-or-none to prevent deadlock.
5. Capture a baseline content hash/absence marker on grant. Immediately before
   mutation, reject the write if an external actor changed that baseline and
   require reread/replan.
6. `afterMutation`, the matching `tool_result`, explicit `close_change_intent`,
   run terminal, disconnect, or expiry releases the lease and wakes the next
   waiter. An agent may keep an intent while actively evaluating the same small
   path set, but not for the duration of the run.

Recommended defaults are a 30-second TTL, heartbeat every 10 seconds, and a
two-minute maximum continuous hold before forced revalidation. The server may
extend while a known mutation tool is still executing. Restart drops all live
leases; recovered runs are interrupted and future claims revalidate hashes.

Same-work-item claims are reentrant by token. Read/read does not conflict.
Write conflicts with read-for-change and write. A rename claims source and
destination. An opaque shell command that may mutate files must either declare
paths through the hook or take a short repository-wide write lease. In
enforced mode, a harness without a pre-mutation hook may not perform live
shared-file writes; it must use worktree mode. Observe-only normalized events
must never be presented as enforced safety.

Add normalized coordination events rather than attempting to infer state from
model prose:

```ts
file_intent_opened     { workItemId, runKey, intentId, paths, reason, expiresAt }
file_lease_acquired    { workItemId, runKey, intentId, paths, token, expiresAt }
file_conflict_wait     { workItemId, runKey, intentId, paths, blockers, queuePosition }
file_lease_released    { workItemId, runKey, intentId, reason }
file_lease_expired     { workItemId, runKey, intentId }
file_baseline_conflict { workItemId, runKey, intentId, path }
```

Leases are volatile coordination state, not durable lifecycle history. Persist
only audit events if product history needs them. The work item stores the
coarse current projection `live_clean`, `live_editing`, or
`live_conflict_wait`.

### Harness integration

Extend `AgentHarness` with an optional mutation-coordination capability:

```ts
interface MutationDescriptor {
  operation: "write" | "delete" | "rename" | "shell";
  paths: string[];
  opaque: boolean;
}

interface HarnessMutationHooks {
  beforeMutation(input: MutationDescriptor): Promise<LeaseGrant>;
  heartbeatMutation(token: string): Promise<void>;
  afterMutation(token: string, result: "success" | "error" | "cancelled"): void;
}
```

Path extractors belong to each harness adapter because current tool names and
inputs differ (`Write`/`Edit`, patch tools, Codex file changes, shell). Add
`workItemId` and `runKey` to the normalized event envelope at the SessionHost
boundary rather than duplicating them in every harness-native event.

## Worktree lineage and merge coordination

A lineage owns an integration branch; a contribution owns a distinct branch
and worktree. Multiple leaders may join one lineage, but they do not check out
the exact same Git branch in multiple worktrees. This respects Git's checkout
rules and makes each leader's uncommitted state independently recoverable.

### Contribution flow

1. Create or join a lineage anchored to `(repository, target branch, target
   SHA)`. Create `minions/lineage/<lineageId>`.
2. For each run, create
   `minions/contribution/<lineageId>/<workItemId>/<runNumber>` and its own
   worktree from the current integration head. Persist the contribution before
   starting the harness.
3. The leader edits only its contribution worktree. Live leases are optional
   here because directories are isolated; they remain useful only when two
   leaders are deliberately assigned the same contribution worktree.
4. On completion, collect the diff and commit any working-tree changes using a
   run-specific commit message. Transition the contribution to `review`.
5. After contribution review, enqueue `integrate_contribution`. The worker
   rebases/merges it onto the latest integration head in the contribution
   worktree and advances the integration ref with `update-ref` CAS.
6. On conflict, abort the Git operation, preserve the worktree, record paths,
   transition both contribution and work item to `worktree_conflicted`, and
   request a new conflict-resolution iteration. A retry re-enters the queue;
   force strategies require explicit user action and an audit record.
7. Clean up a contribution worktree only after its head is reachable from the
   integration branch and its queue item is `succeeded`.

### Promotion to main

Contribution review and final integration review are separate boundaries.
Per-contribution review says a leader's change is acceptable; lineage review
says the combined, ordered result is acceptable for main. By default the
system must run configured gates/tests against the integration head and obtain
final lineage approval before enqueueing `promote_lineage`.

Promotion rebases/merges the latest target into the integration branch away
from the main checkout, validates gates again if the target moved, and advances
the target ref by CAS. If main is checked out and dirty, promotion waits rather
than resetting it. Refreshing the main working tree is a separate post-CAS
best-effort action and must never determine whether the ref update succeeded.

The queue serializes every operation that targets the same ref across all
sessions and lineages. Replace the current `WeakMap<SessionHost, string>` as
the correctness lock; it may remain as a local duplicate-click optimization.

## Commands, events, and queries

All mutating commands carry `requestId`, an idempotency key, and
`expectedLifecycleRevision` (or lineage/contribution revision as appropriate).

```ts
create_work_item
attach_work_item_surface / detach_work_item_surface
start_work_item_run       // first iteration or retry; server allocates runKey
reply_to_waiting_run      // resumes the one open run
review_work_item
archive_work_item / restore_work_item
move_work_item            // workflow column/rank only
open_change_intent / renew_change_intent / close_change_intent
create_change_lineage / join_change_lineage
submit_contribution / review_contribution / enqueue_contribution
review_lineage / promote_lineage
retry_integration / resolve_integration_conflict / discard_contribution
get_work_item / list_work_items / get_work_item_runs
get_change_lineage / get_merge_queue
```

Server events are snapshots with revisions, not imperative UI instructions:

```ts
work_item_created
work_item_changed          { workItem, revision, cause, timestamp }
work_item_run_created      { workItemId, run }
work_item_run_sealed       { workItemId, run }
work_item_binding_changed
change_lineage_changed
change_contribution_changed
merge_queue_changed
```

Extend the topic grammar with `work-item:<id>` and `lineage:<id>`. During
migration, also emit project-scoped copies so clients can discover new items
without subscribing to unknown IDs. Session-native streaming remains on
`session:<runKey>`.

`sync_session` remains a run query. Add `sync_work_item`, which returns the
canonical item, bindings, current run summary, integration summary, and a
cursor/page for run history. Activity and Kanban should normally consume
`list_work_items`; opening a transcript subscribes to its run topic.

## Shared selectors and surface mapping

Place pure selectors in `shared/work-item-lifecycle.ts` and import them from
desktop, mobile, Canvas, and Kanban. No surface may independently translate
raw `SessionStatus`.

| Canonical state | Shared label/badge | Activity | Canvas | Kanban |
| --- | --- | --- | --- | --- |
| `starting` | Starting | open item | node spinner | badge on chosen card |
| `working` | Working | active | active border | badge; no forced move |
| `waiting` + file conflict | Waiting for files | attention | blockers/paths | waiting badge |
| `waiting` + decision | Decision needed | highest attention | input affordance | decision badge |
| `inactive + completed + open` | Ready for review | completion group | completed/review overlay | review badge |
| `inactive + error + open` | Error | error group | error overlay | error badge |
| `inactive + interrupted + open` | Interrupted | interrupted group | interrupted overlay | interrupted badge |
| terminal + `reviewed` | Reviewed | acknowledged group | reviewed check | reviewed badge |
| `archived` | Archived | history filter | optional hidden/dimmed binding | archived/history filter |
| `worktree_queued/integrating` | Integrating | activity detail | merge progress | integration badge |
| `worktree_conflicted` | Merge conflict | attention | conflict actions | conflict badge |

Activity lists work items, not one row per transient run. Expanding an item
shows immutable run history, costs, reports, and outcomes. Its existing
priority order remains: decision, error, interrupted, completion review,
working/waiting, reviewed. Archived items appear only in All/Archived.

Canvas `LeaderData` keeps only view state plus `workItemId` and optionally
`currentRunKey`. Replace reads of persisted `status` and `worktreeStatus` with
the shared selector over the server snapshot. During migration, retain those
fields as a read-only compatibility cache and stop writing them to node data.

Kanban cards persist `workItemId`, workflow column, rank, card content, and
presentation preferences. Remove lifecycle authority from `blockReason`,
archived transcript copies, and `leaderNodeId`. A card may retain an optional
canvas binding for navigation, but loss of that binding never removes the
card. Move Kanban persistence from browser `localStorage` to the global server
database before making it canonical workflow placement; scope every query and
unique constraint by the stable project ID.

## Migration phases

### Phase 0: contract and observability

- Add canonical types, transition functions, selectors, schemas, and contract
  tests without changing UI behavior.
- Add `workItemId`/`runKey` context to server logs and normalized envelopes.
- Instrument tool path extraction in observe-only mode and report coverage by
  harness/tool; do not claim enforcement.

Exit criterion: every existing session lifecycle fixture has an unambiguous
canonical projection and unknown mutation tools are visible in telemetry.

### Phase 1: durable work items and immutable runs

- Create tables and repositories in one idempotent DB migration.
- Propagate the sidecar's stable project ID and canonical project path through
  create-session/work-item commands and persist them on sessions. Reject a
  cross-project binding instead of trying to enforce a foreign key across two
  SQLite files.
- Add `workItemId` to create/start commands. Server allocates all new run keys.
- Implement the atomic new-iteration/reopen transaction and boot recovery.
- Dual-write existing session review transitions to the current work item.
- Backfill one work item per existing leader session, setting run 1 from the
  most reliable terminal/review fields. Mark ambiguous `idle/stopped` rows
  interrupted; never guess completed without a persisted report.

Exit criterion: repeated post-terminal prompts produce distinct immutable
session rows while conversational resume still works.

### Phase 2: server-owned surface projections

- Add work-item list/sync commands and events.
- Convert Activity to work-item selectors, with expandable run history.
- Persist Kanban cards/workflow placement in the server database and migrate each browser's
  local board once using a migration marker. Resolve duplicate imports by
  stable card/work-item IDs and updated timestamp.
- Bind Canvas and Kanban through `workItemId`; make node deletion a detach.
- Remove App-level auto-transition effects after parity tests pass.

Exit criterion: all three surfaces render identical labels for the same
snapshot and survive node removal, refresh, and server restart.

### Phase 3: live-edit intents and leases

- Implement canonical path extraction, volatile coordinator, FIFO wait queue,
  events, expiry, hashing, and UI awareness.
- Add harness pre/post-mutation hooks one harness at a time. Keep unsupported
  harnesses observe-only until coverage is complete.
- Enable enforced live mode only when all mutation routes are intercepted;
  otherwise automatically offer worktree mode.

Exit criterion: overlapping writes deterministically wait, disjoint writes
proceed, external edits trigger baseline conflicts, and crashes release leases.

### Phase 4: worktree lineages and persistent merge queue

- Add lineage/contribution/queue repositories and recovery worker.
- Generalize worktree create/remove so branch names are stored, never derived
  from directory basenames.
- Route new isolated runs through contributions and retain the current merge
  implementation's dirty check and ref CAS.
- Add contribution and final-lineage review/gate commands.
- Migrate an active legacy session worktree into a one-contribution lineage on
  first interaction. Do not move or rename its directory during migration.

Exit criterion: two leaders can contribute concurrently, integrate in a
deterministic order, and promote the combined lineage without losing either
change when the target branch moves.

### Phase 5: remove compatibility authority

- Stop emitting session review state as a competing item lifecycle; retain it
  only as immutable run history during a deprecation window.
- Remove Canvas status persistence, Kanban `idle_review` transitions, archived
  transcript duplication, and per-session correctness locks.
- Add repair tooling for orphan bindings, unsealed runs, stale worktrees, and
  queue entries left running across restart.

## Test matrix

### Lifecycle contracts

- first run, successful completion with/without report, error, abort, process
  loss, and restart recovery;
- completed/error/interrupted followed by a new user iteration creates a new
  run and atomically resets only the item projection;
- reply to a structured wait resumes the same open run;
- duplicate start/review/archive commands are idempotent; stale revisions are
  rejected with the latest snapshot;
- historical reports, dashboard revisions, task plans, usage, and outcomes do
  not change after a later run;
- remove/recreate canvas node and card without losing work-item history.

### Cross-surface contracts

- feed one fixture stream to Activity, Canvas, desktop Kanban, and mobile
  selectors and snapshot the same label, attention rank, outcome, resolution,
  and available actions;
- workflow moves do not alter runtime/outcome; lifecycle changes do not move a
  card unless an explicit automation rule is configured;
- localStorage migration, refresh, reconnect, out-of-order revisions, and
  project switch do not duplicate cards or regress state.

### Live-edit coordination

- same path, directory/file overlap, symlink aliases, rename source/destination,
  multi-path deadlock prevention, fairness, reentrancy, TTL/heartbeat, explicit
  release, tool error, cancellation, disconnect, and restart;
- disjoint writes run concurrently; read/read never blocks;
- external modification after baseline capture rejects mutation;
- opaque shell mutation receives a repository-wide lease;
- enforced mode refuses a harness/tool without pre-mutation interception.

### Worktree/merge coordination

- two and three contributions based on the same SHA integrate in queue order;
- target moves before integration, between integration and promotion, and
  during `update-ref` CAS;
- contribution conflict, final target conflict, dirty main checkout, failing
  gates, forced resolution audit, retry, discard, crash while queued/running,
  and idempotent cleanup;
- no successful contribution branch is deleted before reachability from the
  integration ref is proven;
- queue mutual exclusion is repository/ref-scoped, including sessions from
  different work items and processes.

## Delivery rules

- Server repositories and pure transition functions own canonical mutations;
  React reducers only cache versioned snapshots.
- Every mutation and emitted snapshot is committed in that order: database
  transaction first, then bus event. Reconnect always repairs missed events
  from the current snapshot.
- Use revision CAS for product state, idempotency keys for command retries,
  fencing tokens for workers, and Git SHA CAS for refs. Each protects a
  different race and none substitutes for another.
- Keep schema-versioned payloads additive through the dual-read/dual-write
  window. Remove legacy fields only after telemetry shows no old clients.
- Do not derive completion from prose, Canvas `idle`, Kanban placement, a
  cleaned worktree, or the mere absence of a live process.
