# Leader lifecycle and contribution-lineage completion plan

**Status:** Canonical workflow merged; compatibility removal and final acceptance remain  
**Merged checkpoint:** `3cc9748`  
**Source plan:** [`unified-work-item-lifecycle.md`](./unified-work-item-lifecycle.md)

## Executive summary

The original initiative set out to make Activity, Canvas, and Kanban different
views of one durable unit of work. It also introduced two safe editing modes:

- **live mode**, where agents edit the shared checkout under short file leases;
- **worktree mode**, where agents make isolated contributions that are combined
  in a durable lineage before the result is promoted to the target branch.

The canonical workflow is implemented and merged. Work items now own product
lifecycle, runs preserve immutable iteration history, all three surfaces consume
the same versioned snapshots, live mode enforces coordination when the harness
can intercept mutations, and worktree mode has durable contributions, reviews,
gates, queueing, conflict recovery, and Git compare-and-set protection.

The written plan is not yet literally complete. Phase 5 still has compatibility
code to retire, repair functions are not exposed as an operator workflow, and a
few explicit acceptance cases—most notably a three-contribution lineage—remain
to be added. This document is the handoff for finishing those items without
reopening the architecture delivered in Phases 0–4.

## Original product model

The durable identity is a **work item**. A leader node, Kanban card, harness
session, run, worktree, and contribution are associated records—not competing
definitions of the work.

Lifecycle is intentionally dimensional:

| Dimension | Question answered | Canonical examples |
| --- | --- | --- |
| Runtime | Is an agent doing work now? | `draft`, `starting`, `working`, `waiting`, `inactive` |
| Outcome | How did the latest run end? | `none`, `completed`, `error`, `interrupted` |
| Resolution | What has the user done with that outcome? | `open`, `reviewed`, `archived` |
| Change mode | Where are file changes made? | `live`, `worktree` |
| Integration | What is happening to those changes? | live editing/waiting or worktree active/queued/conflicted/integrated |
| Workflow placement | Where did the user put the card? | a project-defined Kanban column and rank |

This separation creates the consistent mental model the initiative wanted:

- a workflow move does not fabricate a runtime transition;
- a completed or failed item remains open until reviewed or archived;
- a new user iteration creates a new immutable run and atomically returns the
  item to `starting + none + open`;
- Activity, Canvas, desktop Kanban, and mobile render the same lifecycle label;
- deleting a Canvas binding does not delete the work item or its history.

The normal happy path is:

```text
draft → starting → working → inactive/completed/open
      → inactive/completed/reviewed → archived (optional)
```

A later prompt starts another run without rewriting the completed run:

```text
inactive/completed/reviewed → starting/none/open → …
```

## Current implementation state

| Phase | Original objective | Current state |
| --- | --- | --- |
| 0. Contract and observability | Canonical schemas, selectors, envelope identity, mutation telemetry | Complete. Shared work-item contracts and mutation observations are implemented and tested. |
| 1. Durable items and immutable runs | Transactional reopen, distinct run keys, recovery, legacy backfill | Complete. Repeated iterations, child runs, idempotency, CAS, immutable terminal records, and restart recovery are covered. |
| 2. Server-owned projections | Activity/Canvas/Kanban consume one snapshot; server Kanban persistence | Complete on the canonical path. Versioned reconnect merging and local-board import are implemented. |
| 3. Live-edit coordination | Intents, path leases, baselines, fairness, harness enforcement | Complete for supported enforcement. Claude reports complete interception; Codex is observe-only and canonical live requests fall back atomically to worktree mode. |
| 4. Worktree lineages | Durable contributions, merge queue, reviews, gates, conflicts, promotion | Substantially complete and production-wired. The main remaining work is acceptance breadth, not a missing persistence/runtime layer. |
| 5. Remove compatibility authority | Retire legacy lifecycle authority and add repair operations | Partial. Canonical paths are protected, but legacy Kanban/session/worktree code remains and repair functions are not operator-accessible. |

The merged verification checkpoint passed both typechecks, the production
build, license validation, and 4,646 tests. Green verification establishes a
stable checkpoint; it does not by itself satisfy the remaining Phase 5 deletion
and acceptance requirements.

## Contribution lineage design

### The short version

Think of the hierarchy this way:

```text
project/repository
└── lineage: one combined candidate for a target branch
    ├── membership: work item A participates
    │   └── contribution A: A's branch + retained worktree
    │       ├── run A1
    │       └── run A2 (another user iteration on the same contribution)
    ├── membership: work item B participates
    │   └── contribution B: B's branch + retained worktree
    │       └── run B1
    └── integration ref/worktree: the combined result
        └── promotion queue entry → target branch
```

A **contribution** is one work item's durable lane of isolated changes. A
**lineage** is the combined candidate assembled from one or more contributions.
The contribution answers “what did this leader produce?” The lineage answers
“what exact combined change set are we proposing to publish?”

This avoids two unsafe alternatives:

- multiple leaders sharing one mutable worktree with no ownership boundary;
- each leader merging directly to `main`, making the final combined result
  order-dependent and impossible to review as one unit.

### Deliberate evolution from the source plan

The source plan's contribution flow described creating a branch/worktree for
each run. The implemented model refined that boundary: an ordinary new run for
the same work item is attached to the existing editable contribution and keeps
its branch and worktree. The run is still a new immutable attempt, but it does
not create a new Git ownership lane merely because the user sent another
prompt.

That makes the identities line up with their responsibilities:

- **run identity** changes for every user iteration and preserves what happened;
- **contribution identity** remains stable while one leader's proposed change
  is being developed, reviewed, or repaired;
- **lineage identity** remains stable while the combined target candidate is
  being assembled and promoted.

A fresh contribution is created after the prior one becomes terminal through
integration or discard. Conflict-resolution runs are also attached to retained
state: contribution conflicts reuse the contribution worktree, while final
promotion conflicts use the lineage's integration worktree. This is an
intentional implementation decision, covered by repository and service tests,
not an accidental departure from immutable run history.

### Durable objects

| Object | Responsibility |
| --- | --- |
| Work item | Product identity, lifecycle, workflow placement, and current run |
| Run | Immutable record of one agent iteration |
| Lineage membership | Records which work items participate, including historical membership after completion |
| Contribution | Stable branch/worktree for one work item's changes across ordinary iterations |
| Integration ref/worktree | Private staging area containing the ordered combination of accepted contributions |
| Review | Records approval/rejection and the exact SHA reviewed |
| Gate | Records automated policy evidence at contribution or lineage scope |
| Queue entry | Durable, idempotent integration or promotion operation |
| Resolution run | Agent run attached to a retained contribution or integration worktree to resolve a conflict |

### End-to-end lifecycle

1. **Open or join a lineage.** The lineage records the repository, target ref,
   target SHA at open, private integration ref, and retained integration
   worktree. Membership is project/repository checked.
2. **Provision a contribution.** A worktree-mode run receives a stored branch
   and worktree based on the current integration head. Paths and branch names
   are persisted; they are not reconstructed from directory names.
3. **Iterate without changing lanes.** A later prompt on the same work item
   creates a new run but attaches it to the existing contribution branch and
   worktree. New edits invalidate prior gates and SHA-bound approval.
4. **Collect a terminal head.** On completion or interruption, the runtime
   commits/collects the worktree head and moves the contribution to `ready`.
   Errors remain recoverable rather than being mistaken for a reviewable head.
5. **Review the contribution.** Automated gates run at contribution scope.
   User approval records the exact `headSha`; queueing is rejected if the branch
   has changed since that review.
6. **Integrate in queue order.** A durable worker claims the operation for the
   `(repository, target ref)` scope, merges the frozen contribution SHA into the
   integration ref, and commits the resulting state before publishing events.
7. **Review the combined lineage.** After all contributions are integrated or
   discarded, lineage gates evaluate the exact combined integration head. This
   is a second, deliberate review boundary.
8. **Promote.** A lineage queue entry promotes the reviewed integration head to
   the target ref. Git `update-ref <new> <expected-old>` is the final authority;
   a moved target is rebased/retried or reported as a conflict, never overwritten.
9. **Retire safely.** Membership becomes historical after successful promotion.
   A contribution worktree is cleaned only after its reviewed head is proven
   reachable from the durable integrated result.

### Why there are two approvals

Contribution approval and lineage approval protect different questions:

1. **Contribution approval:** “Are this leader's isolated changes acceptable?”
2. **Lineage approval:** “Is the exact combination—and its interactions with
   every other accepted contribution—acceptable for the target branch?”

Approving a contribution cannot safely approve a later combined head. Both
reviews are bound to SHAs, so any subsequent change makes the relevant approval
stale instead of silently inheriting it.

### Conflict behavior

There are two corresponding conflict locations:

- A **contribution conflict** occurs while merging a contribution into the
  integration ref. The contribution branch/worktree is retained. Starting the
  next iteration resolves the conflict in that same contribution lane and
  produces a new head for contribution review.
- A **lineage promotion conflict** occurs between the combined integration head
  and a moved target. A resolution run uses the retained integration worktree.
  Its result becomes a new combined head and must pass lineage gates and final
  review again before promotion.

No conflict path deletes the only copy of unresolved work.

### Concurrency and race protection

The design uses several independent safeguards because each addresses a
different race:

| Safeguard | Protects against |
| --- | --- |
| Lifecycle revision CAS | Stale user/UI mutations of a work item |
| Integration revision CAS | Stale review, gate, queue, and conflict commands |
| Idempotency key and input hash | Retried commands after a lost response |
| Database queue claim | Two workers claiming the same durable operation |
| Fencing token | A stale worker finishing after ownership moved elsewhere |
| Frozen source/target SHAs | Branch movement after review or queueing |
| Git update-ref CAS | Overwriting a target ref that moved concurrently |
| Reachability check | Deleting a contribution before its work is durably integrated |

The database transition commits first. Bus events are notifications, and a
reconnect snapshot repairs any missed notification.

### What the user sees

The UI intentionally exposes the real boundaries as separate actions:

```text
Approve contribution → Enqueue contribution
→ Approve combined lineage → Promote to target
```

Queue state, gates, conflict details, and preserved worktree locations are
projected into Changes, Canvas leader controls, and mobile review. The lineage
is not another top-level task; it is the integration context shared by the work
items that contribute to one target result.

## Remaining work

### P0 — finish Phase 5 compatibility removal

1. Remove the unused browser-local Kanban authority (`use-kanban.ts`) after
   confirming no supported entry point imports it.
2. Remove `idle_review` from Kanban types, reducer actions, rendering branches,
   migrations, and tests. Historical imports should translate it once into the
   canonical lifecycle instead of retaining it as card state.
3. Remove archived message/task-plan/turn duplication from legacy Kanban card
   types and inspector fallback. History views should request immutable run
   history from the work-item API.
4. Retire direct `approve_changes`, `merge_worktree`, force/theirs/retry, and
   per-session operation locks after confirming migration telemetry shows no
   supported client still needs them. Until removal, canonical work items must
   continue to reject those commands.
5. Remove or protocol-version the legacy `session_lifecycle_changed` client
   projection after the deprecation window. Session columns may remain as
   immutable run history, but they must never regain product authority.

### P0 — make repair tooling operational

Expose the existing audits through one authenticated operator command or CLI:

- default to dry-run and return structured findings;
- require an explicit `--apply`/confirmation for repairs;
- cover orphan Canvas bindings, unsealed runs, missing or stale worktrees, and
  queue entries left `running` across restart;
- emit an audit record for each applied repair;
- re-publish affected work-item/lineage snapshots after commit;
- document when a finding is intentionally report-only, such as an unavailable
  project sidecar or dirty retained worktree.

The current functions in `server/work-item-repair.ts` are tested but have no
production caller, so they are a library rather than usable repair tooling.

### P1 — close the explicit acceptance matrix

Add tests that exercise the written plan rather than only nearby primitives:

1. A three-contribution lineage based on one SHA, integrated in deterministic
   queue order and promoted with all three changes present.
2. Repository/ref mutual exclusion using two worker instances and different
   work items/lineages, including stale fencing completion.
3. A full target-conflict recovery journey: promote, target moves, attach a
   lineage resolution run, produce a new head, invalidate approval, re-review,
   and promote successfully after restart.
4. One cross-surface fixture asserting the same label, attention rank, outcome,
   resolution, and available action in Activity, Canvas, desktop Kanban, and
   mobile for every canonical lifecycle state.
5. Remove/recreate Canvas and Kanban bindings while preserving run reports,
   task history, usage, and lineage history.

### P1 — add pre-run lineage assignment

The merged review controls now visualize the current leader contribution,
other contributions, the combined integration ref, and the target. Complete
the assignment workflow at the draft/pre-run boundary:

1. List compatible open lineages for the work item's project and repository.
2. Offer **Create new lineage** (with target branch) or **Join existing
   lineage** before the first worktree run.
3. Preview lineage members, combined head, target, and active queue before the
   user confirms.
4. Commit membership with both work-item and lineage revision CAS, then launch
   the first contribution from the selected integration head.
5. Lock assignment after contribution provisioning. Moving a provisioned
   contribution would invalidate its base SHA, branch ownership, reviews, and
   audit history; the safe alternative is discard plus a new contribution.

### P2 — finish deprecation and operations documentation

- Define the telemetry signal and minimum observation window required before
  deleting each legacy protocol/field.
- Document lineage and contribution states in user-facing language, including
  why combined review is separate from contribution review.
- Add an operator runbook for dirty checkouts, retained conflict worktrees,
  deferred cleanup, restart recovery, and repair dry-runs.
- Record the eventual compatibility-removal commit and flip this document to
  `Complete` only after the definition below is satisfied.

## Recommended delivery sequence

### Slice A — remove passive compatibility state

Delete `idle_review`, browser-local Kanban authority, and archived transcript
duplication. Replace the history fallback with run-history retrieval. Run all
Kanban, Activity, Canvas, mobile, migration, and contract suites.

### Slice B — operational repair and protocol retirement

Expose dry-run/apply repair commands with audit events. Add telemetry-backed
guards, then remove legacy session merge commands, per-session locks, and the
legacy lifecycle projection once the deprecation criterion is met.

### Slice C — acceptance closure

Add the three-contribution, multi-worker fencing, final-conflict recovery, and
cross-surface matrix tests. Run the complete `pnpm verify` pipeline and a manual
desktop/mobile review of the four explicit integration actions.

## Definition of done

The initiative is complete only when:

- Activity, Canvas, desktop Kanban, and mobile have no independent lifecycle
  authority or legacy `idle_review` behavior;
- canonical history is read from immutable runs rather than copied into cards;
- direct session-owned merge correctness paths and locks are retired;
- repair operations are available, auditable, restart-safe, and documented;
- every original lifecycle, cross-surface, live-edit, and worktree acceptance
  case has direct coverage, including a three-contribution lineage;
- `pnpm verify` passes from a clean checkout; and
- the merged commit is deployed/restarted successfully with boot recovery and
  reconnect snapshots observed in a real project.
