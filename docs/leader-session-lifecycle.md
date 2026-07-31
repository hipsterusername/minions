# Leader Session Lifecycle — Continuity, Follow-ups, and Worktree Refresh

Status: **Implemented.** This documents current behavior (as of 2026-07-12) for
how a leader session handles follow-up messages, resumes its SDK conversation,
and refreshes its worktree across approval cycles.

Primary source: `server/commands/send-message.ts`.

---

## Reply continuity: a follow-up resumes, it does not restart

When a user sends another message to an existing leader session, the session
**resumes the same underlying SDK conversation thread** — history and context
are preserved. It does not spin up a fresh, empty session.

The resume is carried by a single value, `resumeId`:

```
send-message.ts  resumeLeader():  resumeId: host.sessionId ?? undefined
        ↓
session-host.ts  start():         this.sessionId = opts.resumeId
        ↓
harness/claude/index.ts:          resume: opts.resumeId  → SDK query options
```

`host.sessionId` is the provider's conversation/thread id from the prior run.
Passing it as the SDK `resume` option tells the provider to continue that
thread. (The Codex harness has the equivalent `resumeThread` vs `startThread`
split — see `docs/codex-harness-spec.md` §3.)

## Two dispatch paths

`send-message.ts` branches on whether the session is backed by a canonical
work item (`host.workItemId`):

1. **Canonical work-item runtime** (`workItemId` present,
   `send-message.ts:47-83`). The message is routed through the work-item
   service:
   - `replyToWaitingRun(...)` when the run is `waiting` on a `decision`.
   - `startRun(...)` when the run is `inactive`/`draft`.
   - Otherwise a `WORK_ITEM_COMMAND_REQUIRED` error asks the client to wait for
     the latest snapshot and retry.
   This path owns its own continuity via the work-item state machine.

2. **Legacy `resumeLeader` path** (no `workItemId`,
   `send-message.ts:111-168`). Uses the `resumeId` resume described above.

   > Note: this path still records the turn as `invocationKind: "new_run"`
   > (`send-message.ts:119-122`). That is a persistence-layer tag pending
   > "Phase 1 persistence [that] can distinguish terminal from open runs" — the
   > SDK conversation itself still resumes. This is a known cleanup, not a
   > continuity bug.

## Approval → change-request conversion

If a leader is **awaiting approval** and the user types a message instead of
clicking Approve, the message is treated as a change request
(`send-message.ts:85-97`):

- `host.taskState.approval` is cleared and persisted.
- The prompt is wrapped with an explanatory prefix so the agent understands the
  user is requesting modifications rather than approving.
- An `approval_resolved` event (`action: "changes_requested"`) is emitted.

## Worktree refresh across cycles

If a leader has worktree isolation enabled but **no live worktree** (i.e. the
previous one was merged or discarded), a fresh worktree is provisioned before
the agent resumes so the next round of edits stays isolated
(`send-message.ts:134-168`, `needsNewWorktree`):

1. `createWorktree(...)` under the project's `.canvas-worktrees/` base.
2. `host.worktree` / `host.cwd` updated and persisted.
3. A `worktree_created` event is emitted, then `resumeLeader(worktreePath)`.
4. On failure, a `worktree_failed` event is emitted and the resume is aborted.

`.canvas-worktrees/` is gitignored (`.gitignore:23`); the merge/promote
dirty-guards rely on that so linked worktree directories are not mistaken for
uncommitted changes. See the integration-test fixtures in
`server/worktree.integration.test.ts` and
`server/git-integration-worker.integration.test.ts` for the minimal setup that
mirrors this.

## Intentional non-features

- **No mid-thread harness switching.** A Claude conversation will not silently
  become a Codex conversation on a follow-up, even if `cmd.harness` is present;
  the host's existing `harnessName` is always reused
  (`send-message.ts:112-116`).

---

## Related docs

- `docs/codex-harness-spec.md` §3 — thread resume semantics per harness.
- `docs/testing-strategy.md` — where lifecycle behavior is tested.
