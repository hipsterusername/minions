# Canonical Task Graph Orchestration Plan

| Field | Value |
| --- | --- |
| Status | Implemented for the static-DAG release; Phase 5 authored dynamic semantics remain guarded |
| Planning authority | Canonical implementation plan |
| Last updated | 2026-08-14 |
| Source basis | Repository architecture and state-machine audit |
| Primary domains | Execution lifecycle, delegation, observability, integration |
| Intended scale | Small plans through 1,000 logical task nodes |

## Contents

1. [Decision](#1-decision)
2. [Outcomes](#2-outcomes)
3. [Current-system assessment](#3-current-system-assessment)
4. [Canonical ownership model](#4-canonical-ownership-model)
5. [Canonical contracts](#5-canonical-contracts)
6. [State and transition model](#6-state-and-transition-model)
7. [Required invariants](#7-required-invariants)
8. [Scheduler semantics](#8-scheduler-semantics)
9. [Cohesion model](#9-cohesion-model)
10. [Persistence and recovery](#10-persistence-and-recovery)
11. [API and event surface](#11-api-and-event-surface)
12. [User experience](#12-user-experience)
13. [Delivery plan](#13-delivery-plan)
14. [Validation strategy](#14-validation-strategy)
15. [Risks and mitigations](#15-risks-and-mitigations)
16. [Required architecture updates](#16-required-architecture-updates)
17. [Definition of done](#17-definition-of-done)

## 1. Decision

Minions should add task-graph orchestration as a server-owned capability built
on canonical WorkItems. It should not execute spatial canvas edges, and it
should not turn the mutable Leader task list into another durable lifecycle.

The ownership rule is:

> A WorkItem owns durable user intent. A TaskGraphRevision owns authored
> topology. A TaskGraphRun and TaskNodeAttempt own execution. Immutable
> artifacts and independent verifications satisfy edges.

The initial scheduler should be a single authoritative server process backed by
transactional SQLite state. A graph may contain 1,000 logical nodes, but active
attempts must remain bounded by configured provider, cost, token, workspace,
and ownership capacity. Width is a planning property, not permission to launch
every node simultaneously.

This plan extends the existing canonical WorkItem model. It does not replace
the spatial canvas graph, the system-model graph, or the underlying persisted
session and provider-invocation records.

## 2. Outcomes

The capability is successful when it provides all of the following:

- Tasks that do not depend on one another can run concurrently.
- Dependencies, joins, retries, timeouts, cancellation, and recovery have
  deterministic semantics.
- A stale or superseded attempt cannot commit output or unblock downstream
  work.
- Agent outputs compose through typed, immutable artifacts rather than prose
  alone.
- Verification is distinct from production and is bound to the exact inputs it
  evaluated.
- File and symbol ownership is enforced through leases rather than warnings.
- A user can identify readiness, blockers, failures, verification, spend, and
  critical path without inspecting raw transcripts.
- Small plans remain lightweight; graph orchestration is optional when a
  direct Leader/Minion loop is simpler.

### Non-goals

- Launching 1,000 provider sessions concurrently.
- Building a general-purpose distributed workflow engine in the first release.
- Treating arbitrary canvas connections as executable dependencies.
- Supporting unrestricted cycles in the initial graph language.
- Replacing WorkItems, session history, worktree integration, or the
  system-model review gates.
- Making a producer's self-report sufficient evidence of correctness.

## 3. Current-system assessment

Minions already has several foundations that should be preserved:

- Canonical WorkItems expose orthogonal lifecycle axes, a current run identity,
  run history, and lifecycle revision
  ([shared/work-item-contracts.ts](shared/work-item-contracts.ts#L13-L80)).
- WorkItem mutations carry both expected lifecycle revision and expected
  current run key
  ([server/work-item-service.ts](server/work-item-service.ts#L11-L58)).
- The repository's accepted lifecycle decision assigns durable intent and run
  history to WorkItems
  ([ADR-002](.systemmodel/decisions/ADR-002-canonical-work-items.md#L1-L13)).
- Child progress and terminal attention are persisted before Leader wake
  ([flow.delegate_and_steer_minions](.systemmodel/flows/delegate_and_steer_minions.yaml#L11-L17)).
- Worktree integration already separates review, queueing, final review, and
  promotion
  ([constraint.gates_and_review_separation](.systemmodel/constraints/gates_and_review_separation.yaml#L1-L24)).

The current task layer is suitable as a small orchestration projection, but not
as the canonical state of a large task graph.

### P0 failure modes

| Failure mode | Evidence | Required correction |
| --- | --- | --- |
| Duplicate lifecycle authority | WorkItems and Leader-local TaskRecords both represent child execution ([work-item contracts](shared/work-item-contracts.ts#L27-L63), [task records](server/task-tools/types.ts#L13-L71)). | Put graph state under the WorkItem aggregate and derive UI task rows from it. |
| Attempts are flattened into logical tasks | Attempt history retains only status, result, and completion time ([task types](server/task-tools/types.ts#L47-L55)); the UI merges by task ID ([LeaderNode.tsx](src/nodes/LeaderNode.tsx#L446-L470)). | Give every attempt a durable identity and retain its session, inputs, outputs, usage, and terminal witness. |
| Events are not revision-fenced | Task lifecycle events mutate by task ID without expected revision or attempt generation ([task-lifecycle.ts](server/task-lifecycle.ts#L288-L326)). | Require graph revision, attempt ID, and fencing generation on every mutation and event. |
| A Leader can complete a live delegated task | complete_task accepts every nonterminal task ([complete-task.ts](server/task-tools/complete-task.ts#L30-L49)); leader completion clears the minion session identity without terminating it ([task-lifecycle.ts](server/task-lifecycle.ts#L199-L205)). | Reject this transition or terminate and fence the active attempt before logical completion. |
| Join membership is implicit and mutable | PendingWait has no awaited task IDs or graph revision ([task types](server/task-tools/types.ts#L96-L108)); wake logic examines all minion tasks and treats blocked as wake-worthy ([leader-wake.ts](server/leader-wake.ts#L17-L48), [wake-coalescer.ts](server/wake-coalescer.ts#L39-L63)). | Persist a frozen join cohort and an explicit satisfaction policy. |
| Retry semantics disagree | Cancelled is modeled as retryable ([task-lifecycle.ts](server/task-lifecycle.ts#L56-L63)) but assign_task rejects it ([assign-task.ts](server/task-tools/assign-task.ts#L108-L129)). | Make retry policy one authoritative transition table and create a new attempt for every retry. |
| Timeouts and recovery lack durable claims | Task timeout state is process-local ([task-lifecycle.ts](server/task-lifecycle.ts#L19-L24)); recovery has no claim or lease to reattach and otherwise projects active tasks to orphaned ([session-registry-recovery.ts](server/session-registry-recovery.ts#L40-L71)). | Persist deadlines, claims, leases, dispatch state, and terminal witnesses. |
| Ownership is advisory | ownedPaths overlap uses exact string equality and produces warnings only ([assign-task.ts](server/task-tools/assign-task.ts#L168-L181)); sibling minions share the Leader worktree ([session-host-agent-context.ts](server/session-host-agent-context.ts#L64-L85)). | Normalize scopes and acquire exclusive or compatible leases before dispatch. |
| Evidence can outlive the inputs it checked | WorkPackets do not identify a graph revision, source snapshot, diff digest, or artifact set ([packet.ts](shared/system-model/packet.ts#L28-L67)); verification rows are caller-supplied kind/target results ([record-verification.ts](server/system-model-tools/record-verification.ts#L12-L66)); gate evaluation selects the latest packet and report without comparing an input digest ([gates.ts](server/system-model/gates.ts#L142-L178)). | Bind every verification and reconciliation result to immutable input hashes and reject stale evidence. |
| Existing UI conflates terminal with successful progress | The plan numerator counts completed, failed, cancelled, and orphaned tasks together ([TaskPlanPanel.tsx](src/nodes/leader/TaskPlanPanel.tsx#L128-L137)). | Display logical outcome, attempt state, and verification independently. |

## 4. Canonical ownership model

The durable hierarchy is:

    AUTHORED, IMMUTABLE

    TaskGraphDefinition
      └─ TaskGraphRevision
           ├─ TaskNode
           └─ TaskEdge

    RUNTIME, APPEND-OR-CAS

    WorkItem
      └─ primary WorkItem run
           └─ TaskGraphRun
                ├─ TaskNodeAttempt
                │    └─ existing child session/run
                │         └─ existing provider invocation generations
                ├─ Artifact
                ├─ Verification
                ├─ EdgeEvaluation
                └─ ResourceReservation

### Record responsibilities

| Record | Responsibility |
| --- | --- |
| WorkItem | Durable user intention, current primary run, resolution, and integration lifecycle. |
| TaskGraphDefinition | Stable graph identity and ownership metadata. |
| TaskGraphRevision | Immutable, validated authored topology and mission contract. |
| TaskNode | Stable logical unit of work within a revision. |
| TaskEdge | Typed dependency and satisfaction policy between logical nodes. |
| TaskGraphRun | One execution of one graph revision within one primary WorkItem run. |
| TaskNodeAttempt | One retryable execution attempt for one logical node. |
| Session/run | Harness-facing child execution identity. |
| Provider invocation | One provider generation or continuation within a session. |
| Artifact | Immutable, content-addressed output committed by the current attempt. |
| Verification | Independent judgment over exact artifact and source hashes. |
| EdgeEvaluation | Durable explanation of why an edge is or is not satisfied. |
| ResourceReservation | Durable budget, provider, and ownership admission claim. |
| Scheduler event/outbox row | Idempotent state transition and side-effect dispatch record. |

TaskRecord may exist temporarily as a compatibility projection during
migration, but it must not remain a second writable authority. The final
TaskPlan UI projection must be derived from TaskGraphRun state.

## 5. Canonical contracts

The exact serialization may use Zod and SQLite columns, but the following
fields are normative.

### 5.1 SourceSnapshot

    SourceSnapshot {
      id
      workItemId
      primaryRunKey
      taskGraphRevisionId
      repositoryBaseCommit
      dirtyDiffDigest
      workspaceId
      worktreeIdentity
      systemModelDigest
      workPacketRevisionId
      connectedContext: [{ sourceId, contentHash, classification }]
      compiledSkills: [{ skillId, version, contentHash, valuesHash }]
      harnessPolicyDigest
      toolPolicyDigest
      createdAt
    }

Every attempt references one SourceSnapshot. “Latest context” must never be
resolved implicitly after admission. Steering that changes mission, context,
scope, constraints, or inputs creates a new graph revision or a new source
snapshot and invalidates affected descendants.

### 5.2 TaskNode specification

    TaskNode {
      id
      taskGraphRevisionId
      title
      objective
      inputBindings
      outputSchemas
      constraints
      acceptanceCriteria
      executorClass
      allowedHarnesses
      allowedTools
      ownershipRequest
      budgetRequest
      timeoutPolicy
      retryPolicy
      verificationPolicy
      failurePolicy
      expansionPolicy
    }

Descriptions are explanatory. Machine-readable bindings, schemas, policies,
and criteria determine readiness and completion.

### 5.3 TaskEdge

    TaskEdge {
      id
      taskGraphRevisionId
      sourceNodeId
      targetNodeId
      kind: control | artifact | verified_artifact | human_gate
      sourceOutput
      targetInput
      satisfactionPolicy
      failurePolicy
      optional
    }

The initial graph language is acyclic. Repetition is represented by bounded
retry, bounded expansion, or a new graph run/revision. A future explicit loop
node must declare a maximum iteration count, exit condition, and budget.

### 5.4 Artifact

    Artifact {
      id
      schemaName
      schemaVersion
      contentHash
      storageRef
      byteSize
      classification: public | internal | sensitive | secret
      retentionPolicy
      taskGraphRunId
      taskNodeId
      producerAttemptId
      sourceSnapshotId
      state: staged | committed | rejected
      createdAt
      committedAt
    }

Artifact content is immutable. Metadata remains queryable after content
expiration. A staged artifact becomes committed only when:

1. its producer attempt is still current;
2. its schema validates;
3. its ownership fence is still valid;
4. its declared write-set matches observed changes; and
5. the commit transaction records edge invalidation and outbox effects.

Secret artifacts must not be copied into prompts, event digests, or graph
labels. Artifact storage belongs under the canonical Minions state root, not an
arbitrary project path.

### 5.5 OwnershipLease

    OwnershipLease {
      id
      taskGraphRunId
      attemptId
      workspaceId
      worktreeIdentity
      scopes: [{
        kind: path | glob | symbol | database | external_resource
        normalizedValue
        mode: read | write | exclusive
      }]
      fencingToken
      acquiredAt
      expiresAt
      renewedAt
      releasedAt
      conflictPolicy
    }

Admission must canonicalize paths, expand or compare globs conservatively,
account for directory ancestry and symlinks, and reject incompatible write
leases. A warning is not a lease.

The initial implementation should prefer one of:

- disjoint enforced write scopes in the shared Leader worktree; or
- a per-attempt worktree with explicit artifact/integration collection.

The two modes must not be presented as providing the same isolation guarantee.

### 5.6 Verification

    Verification {
      id
      taskGraphRunId
      taskNodeId
      producerAttemptId
      verifierAttemptId
      sourceSnapshotId
      artifactHashes
      acceptanceCriteriaVersion
      method: deterministic | independent_agent | human
      evidenceRefs
      result: pending | passed | failed | inconclusive | waived
      confidence
      waiverActor
      waiverReason
      createdAt
      completedAt
    }

A producer can submit claims and evidence, but cannot author the independent
verification verdict for its own output. The verifier receives a fresh context
containing the mission, criteria, exact artifact references, and relevant
constraints. It should not receive the producer's conclusion as trusted truth.

A verification result is stale when any source snapshot, artifact hash,
criteria version, verifier policy, or graph revision differs.

### 5.7 Reconciliation

    Reconciliation {
      id
      workItemId
      primaryRunKey
      taskGraphRunId
      taskGraphRevisionId
      sourceSnapshotId
      workPacketRevisionId
      repositoryBaseCommit
      currentDiffDigest
      artifactHashes
      deterministicChecks
      independentConstraintVerdicts
      reviewGateResults
      provenance
      createdAt
    }

Reconciliation must recompute its deterministic portion from the current diff
and compare the complete input fingerprint. Gate evaluation may use a report
only when that fingerprint still matches. Work Packet amendments should create
immutable revisions; they must not silently rewrite the context under an
existing verification.

### 5.8 Claim and evidence envelope

Agent reports should be structured:

    Claim {
      id
      attemptId
      statement
      evidenceRefs
      affectedArtifacts
      confidence
    }

    AttemptReport {
      attemptId
      outcome
      summary
      claims
      stagedArtifactIds
      observedWriteSet
      unresolvedQuestions
    }

Narrative summaries remain useful to humans, but downstream scheduling must use
the typed fields.

## 6. State and transition model

No single status enum should carry scheduling, execution, outcome,
verification, and integration meaning.

| Axis | States |
| --- | --- |
| Graph run | active, quiescent, blocked, completed, failed, cancelled |
| Logical-node readiness | dormant, ready, unschedulable, satisfied, exhausted |
| Attempt runtime | admitted, claimed, dispatching, running, waiting, terminal |
| Attempt outcome | none, succeeded, failed, cancelled, lost, superseded |
| Verification | not_required, pending, passed, failed, inconclusive, waived |
| Artifact commit | empty, staged, committed, rejected |

Logical-node readiness and graph-run status should be derived projections.
Attempt runtime, outcomes, artifact commits, reservations, and edge evaluations
are durable facts.

### Attempt transition rules

| Current | Event | Next | Guard |
| --- | --- | --- | --- |
| admitted | claim | claimed | Scheduler lease and resource reservations acquired atomically. |
| claimed | enqueue dispatch | dispatching | Outbox row committed in the same transaction. |
| dispatching | provider/session acknowledged | running | Attempt and dispatch generations match. |
| running | report progress | running | Lease valid; progress sequence is newer. |
| running | request input | waiting | Structured wait reason and owner recorded. |
| waiting | provide input | running | Wait token and attempt generation match. |
| running or waiting | terminal report | terminal | First valid terminal witness wins. |
| claimed, dispatching, running, or waiting | lease expires | terminal/lost | Recovery could not prove live ownership. |

Terminal attempts never reopen. Retry always creates a new attempt with a new
attempt ID and generation.

### Logical-node completion

A logical node becomes satisfied only when:

- its current attempt succeeded;
- all required artifacts are committed;
- required verification passed or has an authorized waiver;
- no newer source snapshot or graph revision invalidated the result; and
- its completion transition was committed before downstream edge evaluation.

An attempt's success does not, by itself, satisfy the node.

### Graph-run completion

A graph run is:

- completed when every required terminal node is satisfied;
- failed when an exhausted required node's failure policy makes success
  impossible;
- blocked when no node is runnable and at least one unresolved human or
  external decision can make progress possible;
- quiescent when no attempt is active but a timer, backoff, quota, or lease
  expiry may make progress possible;
- cancelled only through an explicit graph-run cancellation transition.

## 7. Required invariants

1. A TaskGraphRun references exactly one immutable TaskGraphRevision.
2. At most one current nonterminal attempt exists for a logical node in a graph
   run.
3. Every state-changing command carries the expected graph-run revision.
4. Every attempt event carries attempt ID, dispatch generation, actor session,
   and an idempotency key.
5. A stale or superseded attempt may finish, but cannot commit artifacts,
   verification, reservations, or edge satisfaction.
6. A terminal attempt is immutable; later information is an appended witness
   or a new attempt, never a rewritten outcome.
7. A blocked attempt is nonterminal and never satisfies a terminal join.
8. Join membership and policy are frozen before evaluation.
9. Edge satisfaction references the exact upstream artifact and verification
   hashes that caused it.
10. Resource reservation and attempt admission occur in one transaction.
11. Dispatch is recoverable from a transactional outbox and is idempotent.
12. A successful continuation dispatch, not timer creation, acknowledges
    attention.
13. Graph revision changes never mutate the topology of an already running
    revision.
14. Reconciliation and review gates are valid only for their complete input
    fingerprint.
15. All user-visible projections can be rebuilt from durable canonical state.
16. The canvas, Activity, mobile, and agent-tool surfaces do not synthesize
    competing lifecycle states.

## 8. Scheduler semantics

### 8.1 Validation

Before a revision can run, the server validates:

- unique stable node and edge IDs;
- acyclic topology for the initial language;
- all edge endpoints and artifact bindings;
- output/input schema compatibility;
- bounded retry, expansion, timeout, and budget policies;
- satisfiable join definitions;
- known executor classes and allowed tools;
- ownership requests that can be normalized;
- terminal nodes and required outputs; and
- graph size and serialized context limits.

### 8.2 Readiness

A node is ready only when:

1. every required incoming edge has a durable satisfied evaluation;
2. all referenced artifacts and verifications are current;
3. no human, external, retry-backoff, or graph-revision blocker remains;
4. required budget and provider capacity can be reserved; and
5. compatible ownership leases can be acquired.

The scheduler records a machine-readable reason when the node is not ready.
The UI and agent tools consume that same reason.

### 8.3 Join policies

The first release should support:

- all_success: every cohort member is satisfied;
- all_terminal: every cohort member is terminal, regardless of outcome;
- any_success: at least one member is satisfied;
- quorum: at least N of M members are satisfied; and
- reduce: all required artifacts are present, then a reducer node runs.

The cohort is an explicit set of node IDs or expansion-instance IDs frozen at
join creation. Historical tasks outside the cohort and tasks created afterward
cannot change the result.

### 8.4 Claims, leases, and dispatch

The scheduler loop is:

1. Select ready nodes using a deterministic priority order.
2. In one immediate transaction, reserve budget, provider capacity, ownership,
   and a new attempt.
3. Append an outbox dispatch row with a stable idempotency key.
4. Dispatch the child session.
5. Record the returned session/run identity and provider generation.
6. Renew the claim through sequenced heartbeats or progress.
7. On terminal state, stage outputs, validate and commit them, release
   reservations, evaluate affected edges, and schedule newly ready nodes.

Only the scheduler holding the active lease may perform steps 2 through 7.
Even in a single-process release, the lease and fencing token must be durable
so restart behavior is defined and future multi-process execution cannot create
split brain.

### 8.5 Retry and failure

Retry policy declares:

- retryable outcomes;
- maximum attempts;
- backoff and jitter;
- optional executor or model escalation;
- whether committed partial artifacts may be reused; and
- the exhausted-node failure policy.

Failure policy declares one of:

- fail_graph;
- block_for_decision;
- continue_optional;
- satisfy_all_terminal_only; or
- activate_fallback_node.

Cancelled, failed, lost, timed-out, and ended-without-report attempts never
reuse identity. Their evidence and costs remain visible.

### 8.6 Stop semantics

The system must distinguish:

- end Leader turn: children continue;
- pause graph scheduling: no new attempts, existing attempts continue;
- interrupt attempt: current provider turn stops but the attempt may remain
  resumable;
- cancel attempt: the attempt becomes terminal and its lease is fenced;
- cancel graph run: all active attempts are fenced and terminated according to
  policy;
- close/remove surface: detach UI binding without erasing canonical history;
  and
- archive WorkItem: allowed only at a valid canonical lifecycle boundary.

## 9. Cohesion model

Scheduling determines who runs and when. Cohesion determines whether parallel
results still solve the same problem.

| Scheduling concern | Cohesion concern |
| --- | --- |
| Dependencies and joins | Shared mission, scope, and non-goals |
| Admission and concurrency | Minimal role-specific context |
| Claims, leases, and retry | Typed handoffs and output schemas |
| Provider and cost quotas | Claims backed by evidence |
| Timeouts and critical path | Independent verification |
| Crash recovery | Scope drift and contradiction handling |

### Mission contract

Every TaskGraphRevision freezes:

- normalized objective;
- acceptance criteria;
- non-goals;
- architectural constraints;
- source snapshot;
- expected terminal outputs;
- cost and time envelope; and
- escalation rules.

Individual nodes receive only the mission fields relevant to their scope plus
artifact references for their dependencies. The current default of copying the
latest canvas context into every child prompt
([assign-task.ts](server/task-tools/assign-task.ts#L86-L95)) should become an
explicit scoped manifest. Large shared context is stored once and referenced by
hash.

### Contradiction and drift handling

An attempt that finds contradictory requirements must emit a structured
disagreement rather than silently choosing one. The scheduler can:

- block for a human decision;
- launch an independent adjudicator;
- select a declared precedence rule; or
- create a revised graph.

Steering is an append-only, revisioned event. It identifies the affected nodes,
explains the change, and records which committed artifacts and verifications
became stale.

### Reduction

Large fan-outs should synthesize hierarchically:

1. leaf attempts emit typed artifacts and claims;
2. stage reducers reconcile duplicates and disagreements;
3. independent verifiers evaluate stage outputs;
4. a final reducer consumes verified stage artifacts.

Reducers must expose missing inputs, conflicts, and excluded claims. They may
not hide failed verification behind a prose summary.

## 10. Persistence and recovery

Suggested canonical tables:

- task_graph_definitions
- task_graph_revisions
- task_graph_nodes
- task_graph_edges
- task_graph_runs
- task_node_attempts
- task_edge_evaluations
- task_artifacts
- task_verifications
- task_resource_reservations
- task_scheduler_events
- task_scheduler_outbox

Existing sessions and run_invocations remain the execution substrate. A
TaskNodeAttempt points to a child run key rather than duplicating provider
session lifecycle.

### Transaction boundaries

The following must be atomic:

- graph-run revision CAS and attempt admission;
- budget/provider/ownership reservation acquisition;
- terminal attempt witness and reservation release;
- artifact commit and downstream invalidation;
- edge evaluation and ready-queue projection;
- attention creation and wake outbox insertion; and
- reconciliation fingerprint and gate-result publication.

Broadcasts occur only after commit through the typed event bus.

### Restart algorithm

1. Hydrate WorkItems, graph revisions, graph runs, attempts, sessions,
   provider invocations, reservations, artifacts, verification, and outbox.
2. Acquire the scheduler lease with a new fencing generation.
3. Reconcile claimed attempts against durable session and provider witnesses.
4. Reattach provably live attempts; mark an attempt lost only when neither a
   live lease nor a terminal witness survives.
5. Expire stale reservations and reject their staged artifacts.
6. Recompute edge evaluations whose inputs changed.
7. Rebuild the ready projection.
8. Replay undelivered outbox rows idempotently.
9. Publish one revisioned full snapshot before incremental events.

This procedure must be safe to repeat after a crash at every step.

## 11. API and event surface

The API should expose intention-level commands rather than raw status writes.

### Commands

- create_task_graph_revision
- validate_task_graph_revision
- start_task_graph_run
- pause_task_graph_run
- resume_task_graph_run
- steer_task_graph
- retry_task_node
- cancel_task_attempt
- cancel_task_graph_run
- provide_task_input
- request_task_verification
- waive_task_verification
- get_task_graph_snapshot
- list_task_graph_attempts
- get_task_artifact
- reconcile_task_graph_run

Every mutation includes request ID, expected graph-run revision, and relevant
current attempt or artifact hashes. Conflicts return the latest canonical
snapshot.

### Events

- task_graph_snapshot
- task_graph_run_changed
- task_node_readiness_changed
- task_attempt_changed
- task_artifact_committed
- task_verification_changed
- task_edge_evaluated
- task_graph_attention_requested
- task_graph_usage_changed
- task_graph_reconciliation_changed

Incremental events carry graph-run revision and stable object IDs. Clients
discard regressions and request a full snapshot when they detect a gap.

## 12. User experience

### Product placement

The spatial canvas should show a compact WorkItem/TaskGraphRun summary and an
“Open graph” action. It should not materialize every logical node or attempt as
a canvas node. The current GraphDocument is explicitly a visual protocol
contract rather than a runtime
([src/graph.ts](src/graph.ts#L1-L10)).

The primary interface is a dedicated server-backed Graph Inspector.

### Graph Inspector layers

1. Overview
   - logical progress;
   - running attempts and ready queue;
   - blocked, exhausted, and failed nodes;
   - verified and unverified outputs;
   - spend, remaining budget, and token usage;
   - observed and estimated critical path.
2. Topology
   - authored logical nodes and typed edges;
   - stages, expansion groups, reducers, and terminal outputs;
   - critical-path and failure-propagation highlighting.
3. Work queue
   - virtualized task rows;
   - priority, queue age, executor, current attempt, backoff, and a canonical
     “why not running?” reason.
4. Evidence lineage
   - source snapshot to producer attempt to artifact to verifier to consumer.
5. Event timeline
   - claims, dispatches, progress, retries, steering, invalidation, waiver, and
     recovery decisions.
6. Detail drawer
   - logical specification;
   - attempt history;
   - current session;
   - inputs and outputs;
   - evidence and verification;
   - ownership and budget reservations;
   - logs and cost.

### Visual encoding

- Node fill represents logical outcome.
- A thin outer ring represents the current attempt/runtime.
- A shield or check marker represents verification.
- A compact badge represents the primary blocker category.
- Cost is shown per node and aggregated by stage or subtree.
- Edge emphasis is reserved for selection, critical path, or failure
  propagation.
- Attempt history is never drawn as duplicate topology nodes by default.

### Scale rules

For large graphs:

- collapse stages, map expansions, and completed subtrees;
- aggregate status and cost by group;
- virtualize the work queue and detail lists;
- mount only visible topology labels and details;
- hide ordinary edges until selection or semantic zoom;
- preserve stable layout between snapshot revisions;
- offer filters for ready, blocked, failed, unverified, expensive, stale, and
  critical-path nodes; and
- retain a deterministic table view when the topology is too dense.

At every scale the user must be able to answer:

1. What is running?
2. What is ready but waiting for capacity?
3. What is blocked, and by what?
4. What failed: an attempt or the logical task?
5. Which outputs are verified?
6. What has this run cost and what budget remains?
7. Which chain currently determines completion time?

## 13. Delivery plan

### Phase 0 — Harden the existing loop

Scope:

- fix cancelled-task retry semantics;
- prevent Leader completion from orphaning a live child;
- add attempt/session fencing to existing task lifecycle events;
- persist task deadlines;
- make wait cohorts explicit;
- align live and restart wake semantics; and
- expose failed versus successful task counts separately.

Exit criteria:

- model-based lifecycle tests reject illegal transitions;
- late reports from superseded attempts are ignored;
- cancellation and retry agree across tools, reducer, persistence, and UI;
- restart preserves deadlines and join membership; and
- no live child can mutate after its task is declared complete.

### Phase 1 — Canonical graph schema and revisioning

Scope:

- author the task-graph ADR and system-model objects;
- add graph definition, revision, node, edge, run, and attempt contracts;
- add transactional persistence and migration;
- attach graph runs to canonical WorkItem primary runs; and
- derive the existing TaskPlan projection from canonical graph state.

Exit criteria:

- one server snapshot reconstructs authored topology and runtime attempts;
- clients cannot write lifecycle projections directly;
- graph revisions are immutable and CAS-fenced; and
- the legacy TaskRecord writer is removed at cutover.

### Phase 2 — Static DAG scheduler

Scope:

- validation and readiness;
- frozen joins;
- durable scheduler lease;
- resource reservations;
- transactional outbox;
- bounded retry/backoff;
- pause, cancel, and recovery; and
- deterministic failure propagation.

Exit criteria:

- crash-injection tests cover every dispatch and completion boundary;
- duplicate scheduler loops cannot double-dispatch or double-commit;
- a 1,000-node synthetic DAG can be scheduled with bounded concurrency;
- restart reconstructs the same ready set; and
- every non-ready node has one canonical reason.

### Phase 3 — Artifacts, verification, and reconciliation

Scope:

- content-addressed artifact metadata and storage;
- typed input/output binding;
- independent verifier attempts;
- claim/evidence envelopes;
- immutable Work Packet revisions;
- reconciliation fingerprints; and
- gate integration bound to artifact and diff hashes.

Exit criteria:

- stale attempts cannot commit artifacts;
- changed inputs invalidate downstream evidence;
- a producer cannot mark its own independent verification passed;
- gate evaluation rejects a report for a different diff or artifact set; and
- artifact classification and retention are enforced.

### Phase 4 — Graph Inspector

Scope:

- overview, topology, work queue, evidence lineage, timeline, and detail drawer;
- server-side aggregate projections;
- semantic zoom and group collapse;
- critical-path calculation; and
- state-scoped controls.

Exit criteria:

- small graphs remain legible without opening the Inspector;
- a 1,000-node fixture does not render 1,000 expanded rows or all edges at once;
- all seven operator questions in section 12 are answerable from canonical
  projections; and
- attempt state is never visually conflated with logical completion or
  verification.

### Phase 5 — Dynamic expansion and hierarchical reduction

Scope:

- bounded map expansion;
- expansion-instance cohorts;
- reducer templates;
- contradiction/adjudication workflows; and
- optional model escalation.

Exit criteria:

- expansion limits and budgets are validated before dispatch;
- joins use the exact frozen expansion cohort;
- reducers surface missing or contradictory inputs; and
- graph growth cannot bypass admission, verification, or ownership policy.

## 14. Validation strategy

### Reducer and property tests

- every legal transition succeeds and every illegal transition is rejected;
- terminal attempts are immutable;
- one current attempt per logical node;
- graph-run completion is independent of event ordering;
- join results are permutation-invariant;
- revisions never mutate after activation; and
- stale generations cannot change canonical state.

### Persistence and crash tests

Inject failure:

- before and after claim commit;
- before and after outbox insertion;
- before and after provider allocation;
- before and after terminal witness;
- before and after artifact commit;
- before and after edge evaluation;
- before and after wake delivery; and
- during scheduler lease takeover.

Every case must result in either one committed effect or a recoverable pending
effect, never a silent loss or duplicate commit.

### Contract tests

- all command schemas require revision fences;
- every event includes canonical IDs and revision;
- all surfaces converge after a full snapshot plus deltas;
- artifact schema incompatibility blocks readiness;
- ownership conflicts block admission;
- verification and reconciliation reject mismatched hashes; and
- system-model gates remain distinct from review and promotion.

### Cohesion evaluations

Use representative multi-agent fixtures to measure:

- duplicate or contradictory claims;
- unsupported claims reaching reducers;
- artifacts omitted from synthesis;
- verifier agreement and correlated-error rate;
- context bytes per attempt;
- scope violations; and
- human interventions per graph run.

These are quality diagnostics, not substitutes for deterministic correctness
tests.

### Performance tests

Use fixtures for 10, 100, and 1,000 logical nodes with bounded active attempts.
Measure:

- snapshot size and serialization time;
- ready-set recomputation;
- scheduler transaction latency;
- restart reconciliation;
- event fan-out;
- Graph Inspector mount and filter latency; and
- memory use with collapsed groups and virtualized lists.

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Third canonical lifecycle emerges | Make graph state subordinate to WorkItem and remove legacy TaskRecord writes at cutover. |
| Scheduler split brain | Durable scheduler lease, fencing generation, CAS, and idempotent outbox. |
| Correlated verification | Fresh verifier context, distinct attempt identity, exact artifact hashes, and optional human gate. |
| Context growth despite parallelism | Content-addressed SourceSnapshot plus per-node manifests and bounded retrieval. |
| Parallel write corruption | Enforced ownership leases or per-attempt worktrees; no warning-only mode presented as safe. |
| Stale system-model evidence | Immutable Work Packet revisions and reconciliation fingerprints. |
| Artifact secret leakage | Classification, redaction, retention policy, access checks, and no secret content in event summaries. |
| Unusable 1,000-node visualization | Aggregate first, semantic zoom, virtualized rows, edge suppression, and deterministic table fallback. |
| Product complexity for simple work | Preserve the direct Leader/Minion path and introduce a graph only when dependency or fan-out warrants it. |
| Runaway loops or spend | Acyclic initial language, bounded expansion/retry, atomic budget reservations, and explicit cancellation. |

## 16. Required architecture updates

Before Phase 1 implementation merges:

1. Add an accepted ADR for server-owned task-graph orchestration.
2. Extend capability.task_orchestration with graph revision, scheduling,
   artifact, verification, and inspection entry points.
3. Add constraints for:
   - one active graph attempt per logical node;
   - attempt-generation fencing;
   - frozen join cohorts;
   - artifact and verification hash binding;
   - scheduler lease and outbox ordering;
   - ownership lease enforcement; and
   - task-graph snapshot convergence.
4. Add flows for:
   - author and validate a graph revision;
   - schedule and recover a graph run;
   - verify and reconcile graph artifacts; and
   - inspect and control a graph run.
5. Add review-gate coverage for the new persistence, scheduler, command,
   contract, and Graph Inspector surfaces.

The system model should be updated from the landed contracts and tests, not
from speculative file names alone.

## 17. Definition of done

Task-graph orchestration is complete only when:

- WorkItem remains the sole durable owner of user intent and current run
  lifecycle.
- Authored topology and runtime attempts have separate durable identities.
- All state transitions, dispatches, retries, and recovery operations are
  revision-fenced and idempotent.
- Join semantics are explicit and cohort-scoped.
- Resource, budget, and ownership admission is transactional.
- Artifacts are typed, immutable, content-addressed, and provenance-bearing.
- Verification is independent and bound to exact inputs.
- Reconciliation cannot apply stale evidence to a changed diff or artifact set.
- Every UI surface derives from the same canonical server snapshot.
- The Graph Inspector remains useful for both small and 1,000-node graphs.
- The direct Leader/Minion workflow remains available for simple tasks.
- Required unit, property, contract, crash-recovery, architecture, cohesion,
  and performance tests pass.
