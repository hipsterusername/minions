# Durable leader/minion lifecycle

The orchestration loop is:

`plan -> assign -> run/report -> durably record attention -> wait/wake -> synthesize -> complete`

A provider turn ending is not the end of this loop. The loop ends only when the Leader has observed every required child outcome, synthesized it, and completed the parent work.

## Gaps closed

Before this contract was enforced, the flow had seven independent gaps:

1. `pendingWait` stored a live timer handle and was never persisted.
2. queued and coalesced wakes lived only in `WeakMap`s, so restart erased them.
3. the child terminal transition and parent wake were separate operations; a crash between them lost the wake.
4. a child could finish while its Leader was still running and the idle-only wake path would never retry.
5. hydration reconciled each Leader before all minion sessions existed, so it could not use the child's durable terminal evidence.
6. hydration changed blocked tasks to orphaned even though blocked children are intentionally resumable.
7. the legacy `task_records` projection omitted wait state, attempt history, progress, skills, file ownership, constraints, and acceptance criteria.

## State machines

### Task lifecycle

| State | Legal next states | Durable meaning |
| --- | --- | --- |
| `planned` | `starting`, `completed`, `cancelled` | Stable task identity exists. |
| `starting` | `running`, `blocked`, terminal | A child has been allocated but may not have initialized. |
| `running` | `running`, `blocked`, terminal | Progress can update without changing identity. |
| `blocked` | `running`, terminal | Nonterminal and resumable; the question requires Leader attention. |
| `completed` | final | Child or Leader reported success. |
| `failed` | `starting` on retry | Failure is terminal for the attempt, not necessarily for the task identity. |
| `ended_without_report` | `starting` on retry | The child ended cleanly without the required report. |
| `orphaned` | `starting` on retry | No resumable live child or terminal witness survived recovery. |
| `cancelled` | `starting` on retry | Explicit teardown or cancellation ended the attempt. |

Blocked and meaningful terminal transitions create `attentionRequestedAt`. `attentionDeliveredAt` remains null until a Leader continuation is successfully dispatched. This pair is the durable wake outbox.

### Leader wait lifecycle

| State | Representation | Exit |
| --- | --- | --- |
| active | `pendingWait = null` | Leader calls `wait_and_continue` or ends its turn. |
| waiting | persisted `pendingWait` with deadline and wake policy | timer deadline or matching child condition |
| wake queued | wait still persisted and/or child attention undelivered | successful continuation dispatch |
| wake delivered | wait cleared and attention delivery timestamp persisted | Leader resumes the workflow loop |

The wait is deliberately not cleared when a coalesced wake is merely scheduled. Clearing it before dispatch recreates the lost-wake window.

### Session history lifecycle

Every Leader and minion is an independent persisted session. Transcript events append to `event_log`; the in-memory replay buffer is bounded, but restart hydration must restore its recent ordered tail. History is removed only by an explicit eligible `clear_session` or `remove_session`; canonical run history is protected from those legacy commands.

## Commit and delivery ordering

For a child report or terminal observation:

1. reduce the task event idempotently;
2. set the task outcome or blocked state and create durable attention;
3. transactionally persist the legacy task projection and the complete workflow snapshot;
4. only after persistence succeeds, request the Leader wake;
5. coalesce while the Leader is active, without dropping the request;
6. dispatch the continuation;
7. after successful dispatch, persist `attentionDeliveredAt` and clear a completed wait.

Canonical WorkItem wakes use a deterministic request key derived from the resumed run and prompt, so retry is idempotent. Legacy bare-session dispatch is at-least-once: a crash in the narrow interval after provider dispatch and before the delivery checkpoint can duplicate a continuation, but it cannot silently lose it.

## Restart reconciliation

Recovery is graph-wide, not row-local:

1. hydrate every Leader and minion session, transcript tail, review witness, and full task snapshot;
2. only after the complete session map exists, reconcile `starting` and `running` tasks;
3. project a child's durable `completed`, `error`, `stop`, or `abort` witness into the parent task;
4. mark a task orphaned only when no terminal witness or resumable execution survives;
5. preserve `blocked` exactly as blocked;
6. rebuild wait timers from `scheduledAt + durationMs`;
7. dispatch any satisfied wait or undelivered attention, including for a Leader rehydrated as stopped.

This recovery is safe to repeat. Terminal task reductions are idempotent, delivered attention is skipped, and canonical wake request IDs deduplicate replay.

## Invariants

- A Leader wake never precedes durable parent task state.
- A queued wake remains derivable from persisted wait or attention state.
- A terminal report is immutable within an attempt.
- A blocked task is nonterminal and resumable.
- Child session history is independent of the parent task row.
- Hydration observes the complete session graph before declaring children orphaned.
- A successful dispatch, not timer creation, acknowledges attention.
- Persistence failure favors a retained pending wake over an untraceable continuation.
