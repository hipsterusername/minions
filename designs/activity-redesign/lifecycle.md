# Activity session lifecycle

This contract backs the Activity surface.

Activity presents every session that has not been explicitly dismissed. A
runtime ending is not the same as a user-visible item being resolved.

## Two orthogonal state machines

The server owns both state machines and persists every transition.

### Runtime state

`creating -> running <-> waiting -> inactive`

`inactive` only means that no harness process is currently doing work. It does
not express the outcome of the task.

### Review state

- `none`: no user action is currently expected.
- `decision_needed`: the system has an explicit structured input request that
  has not been answered.
- `completion_to_review`: the run ended successfully with a final report. The
  user is expected to read the final agent message and inspect dashboard
  artifacts.
- `error_to_review`: the harness emitted a terminal error.
- `interrupted_to_review`: the run became inactive without a successful final
  report or terminal error. This includes abort, process loss, disconnect, and
  server restart while a run was active.
Acknowledgement and dismissal are independent timestamps, not outcome states.
This preserves the underlying decision/completion/error/interruption exactly:
an acknowledged or dismissed error is still an error in history, and restoring
it cannot lose that fact.

## Deterministic inputs

Review state is derived only from structured system events:

| Event | Review transition |
| --- | --- |
| Structured input request opened | `decision_needed` |
| Input request answered and run resumes | `none` |
| `done(completed)` plus persisted final assistant report | `completion_to_review` |
| `done(error)` | `error_to_review` |
| `done(abort/stop)` without a final report | `interrupted_to_review` |
| Live run disappears or is found active during restart recovery | `interrupted_to_review` |
| User acknowledges | `acknowledged` |
| User dismisses | `dismissed` |
| User resumes/retries | review state returns to `none`; runtime becomes `creating` |

No transition depends on parsing model prose, matching question marks, or
guessing from the last message.

## Completion invariant

`completion_to_review` is legal only when all of the following are persisted:

1. a terminal `done(completed)` event,
2. a final assistant report identifier,
3. the dashboard artifact revision visible at completion.

If the terminal event arrives without a final report, classify the session as
`interrupted_to_review`, not complete.

## Persistence shape

Each session snapshot needs:

- `runtime_state`
- `review_state`
- `review_reason`
- `final_report_event_id`
- `final_dashboard_revision`
- `terminal_reason`
- `terminal_at`
- `acknowledged_at`
- `dismissed_at`
- monotonically increasing `lifecycle_revision`

Commands use compare-and-set against `lifecycle_revision`. Duplicate terminal,
acknowledge, dismiss, or reconnect events are idempotent.

## Activity ordering

The default **Open** filter includes all non-dismissed sessions, ordered:

1. decision needed,
2. error,
3. interrupted,
4. completion to review,
5. currently working/waiting,
6. acknowledged but not dismissed.

Within a class, sort by the latest lifecycle transition. “All” includes open
and dismissed history; “Dismissed” is the explicit history filter.

## Recovery

On boot, the server reconciles persisted runtime state with live harnesses.
Any session persisted as creating/running/waiting with no corresponding live
run transitions once to inactive + interrupted. Existing terminal outcomes are
preserved; hydration must never rewrite them all to `stopped`.
