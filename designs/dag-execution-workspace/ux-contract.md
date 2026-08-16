# Graph-task funnel: observable UX contract

Status: implementation handoff for the existing client projection. This contract does not create scheduler, persistence, schema, approval, integration, skill, or sandbox behavior.

## State vocabulary

The UI derives its stage from the latest server-owned WorkItem, plan proposal, graph projection, and Activity truth. It never advances the durable lifecycle optimistically.

| Funnel stage | Required observable facts | Leader node / embedded Dashboard | Activity | Graph Inspector |
|---|---|---|---|---|
| `proposal_review` | Plan snapshot exists; proposal is `ready`, `needs_input`, `stale`, or `rejected`; no canonical run is implied | Proposal card is the primary object. Show objective, revision, steps, parallelism, approvals, questions, and Start/Adjust/Reject | Optional pending-plan row only if already represented by server truth | Details dialog may explain topology, but has no runtime controls |
| `executing` | Canonical `graphRunId`; status `running`, `quiescent`, `blocked`, or `paused`; monotonic run revision | Compact summary leads with goal, logical progress, active/attention counts, cost, and Open graph | Triage by `needs-you`, working, and waiting; no duplicate graph state | Full topology/history projection; controls use displayed revision and current attempt fences |
| `intervention` | A decision wait, failed/exhausted attempt, failed verification, or actionable blocker exists | Summary elevates one “Needs you” action without replacing overall progress | Primary re-entry surface; explains the decision and whether unaffected work continues | Selecting the Activity item opens the exact node/attempt and only capability-supported controls |
| `completed_review` | Canonical run is terminal; outputs and verification status are projected; review state is independent | Terminal summary remains inspectable | Primary surface: Review & keep and Review & remove are distinct | Read-only terminal revision remains available; promotion/integration is not implied |
| `recovering` | Connection lost, reconnect in progress, or incoming revision is non-adjacent to displayed revision | Last known summary may remain visible with stale treatment | Entry remains visible but actions are unavailable | Freeze controls, label last displayed revision, refetch a full snapshot, then replace local projection |

Within execution, node state is a product of separate fields: logical outcome, readiness, current attempt, blocker, and verification. Never collapse “waiting for dependency,” “ready but capacity-limited,” “decision wait,” “attempt failed,” and “verification failed” into one generic blocked state.

## Transition contract

| From → to | Trigger owner | UI request | Confirmation required before rendering target |
|---|---|---|---|
| Proposal → executing | User | Start once with current proposal/source fences | Server returns the canonical run snapshot. Duplicate start keys are idempotent. |
| Proposal → revised proposal | User, then server | Adjust in chat or refresh a stale proposal | New proposal revision replaces the old proposal. Pending approval is not erased by sync. |
| Executing → executing | Automatic | Fold adjacent typed deltas by stable IDs | Incoming `revision === displayedRevision + 1`; otherwise enter recovery. |
| Executing → intervention | Automatic detection; user resolves | Surface the exact decision wait, attempt, blocker, or verification | Only decision waits accept replies. Attempts continue only after server confirmation. |
| Intervention → executing | User | Provide input, retry, verify, waive with reason where allowed, resume | Send `requestId`, `graphRunId`, `expectedRunRevision`, `nodeId`, and `currentAttemptId`; replace with returned snapshot on conflict. |
| Executing → paused | User | Pause scheduling | Server status is `paused`; active attempts may continue if the capability semantics say so. |
| Paused → executing | User | Resume scheduling | Server status returns to an executing status. Unsupported controls produce a visible typed error. |
| Executing → completed review | Automatic | None | Terminal run revision plus output/verification projection. Completion does not integrate changes. |
| Completed review → reviewed/retained | User | Review & keep | Activity acknowledgement succeeds; the WorkItem remains available. |
| Completed review → reviewed/removed | User | Review & remove | Remove/detach succeeds under the canonical lifecycle. This is distinct from promotion. |
| Any projected stage → recovering | Automatic | Stop folding deltas and refetch | Reconnect or revision gap detected; local controls freeze immediately. |
| Recovering → server-derived stage | Automatic | Fetch full WorkItem graph snapshot | Full snapshot revision is installed atomically; no missing state is invented client-side. |

## Stable identity and action fences

- WorkItem topic owns the bounded projection. Topology, history, readiness, evidence, and lifecycle are server-owned.
- Use stable `node.id`, `attempt.id`, evidence ID/artifact ID, plan `taskId`, and component IDs across surfaces. A selection may travel between Activity and Inspector by those identities.
- Every runtime mutation carries `requestId`, `graphRunId`, `expectedRunRevision`, `nodeId` when applicable, and the displayed `currentAttemptId` when applicable.
- On stale-fence conflict, apply no partial side effect. Install the returned current snapshot or refetch it, announce the conflict, and let the user retry from current truth.
- Graph controls are hidden or disabled when synced harness/capability facts do not support them. A sent command is not success; only the typed server result advances the view.

## Surface hierarchy

1. Leader node proposal card: decide whether the plan may become a run.
2. Embedded Dashboard summary: monitor goal, logical progress, attention, budget, and open the graph.
3. Activity: triage across WorkItems and re-enter the exact item that needs a person.
4. Graph Inspector: diagnose topology, attempts, evidence, queueing, and history; perform fenced controls.

The authored plan remains visible as a stable rail/lens. Runtime nodes map to plan items only by canonical task ID or minion session identity. Evidence checkpoints remain inspectable objects, not unlabeled edges.

## Responsive sizing contract

Sizing has two owners: CSS/container layout automatically chooses a mode; the user controls rail disclosure inside that mode.

| Available Inspector width | Automatic layout | User-driven behavior |
|---|---|---|
| `>= 1120px` | Three columns: plan `246px`, graph `minmax(440px, 1fr)`, detail `304px` | Either rail may collapse to a `42px` edge tab; selection opens detail |
| `900–1119px` | Compact three columns: plan `220px`, graph `minmax(430px, 1fr)`, detail `270px` | Same independent rail toggles; graph is never narrower than its readable floor |
| `< 900px` | Graph plus two `42px` edge tabs; open rails overlay at `246px`/`304px` | Rails start collapsed on first narrow entry; opening one does not resize the graph; Escape/close returns focus |
| `< 620px` | Mission and metrics condense; toolbars scroll; lineage and manifests stack; bottom iteration labels abbreviate | Stage/filter/tab choices remain reachable by keyboard and horizontal scroll |

Crossing from wide to narrow automatically collapses both rails once. Resizing back to wide does not silently reopen a rail the user explicitly collapsed. Opening a node selection is user-driven and may open the detail overlay. `prefers-reduced-motion` removes nonessential animation.

## Accessibility and recovery requirements

- Proposal and Inspector are labelled modal dialogs with focus entry, a focus loop, Escape behavior, and focus restoration.
- Tabs use `tablist`/`tab`/`tabpanel`, roving focus, and arrow/Home/End navigation.
- State is encoded by text and shape as well as color. Status announcements use polite live regions; conflicts and failed commands use alerts.
- During recovery, preserve last known content for orientation, visibly mark it stale, disable mutations, and avoid fake progress.
- Event buffers may be bounded, but initial sync and recovery sync are complete snapshots before incremental folding resumes.

## Implementation anchors

- `src/task-graph/GraphPlanProposal.tsx`: proposal review and start/adjust/reject separation.
- `src/task-graph/GraphSummaryCard.tsx`: embedded Dashboard summary.
- `src/ActivityView.tsx`: WorkItem triage, acknowledgement, retention, and removal.
- `src/task-graph/GraphInspector.tsx`: projection lenses, selection, responsive rails, and fenced actions.
- `src/task-graph/types.ts`: action fence and plan mapping types.
- `src/task-graph/use-task-graph-view.ts`: snapshot/delta convergence and recovery behavior.

