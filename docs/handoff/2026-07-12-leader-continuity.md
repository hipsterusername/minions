# Leader Handoff — Reply Continuity & Push to Main

**Date:** 2026-07-12
**Session:** "Leader reply continuity + push"
**Branch:** `main` (in sync with `origin/main` as of `99624c1`)

This is a context handoff for the next leader session. It records what was
verified, what was changed and shipped, and what remains open. Read this first,
then `docs/leader-session-lifecycle.md` for the mechanics it references.

---

## TL;DR

- The "replying to a leader spawns a brand-new session" bug is **fixed and on
  `main`.** Follow-up messages resume the same SDK conversation thread via
  `resumeId`.
- `pnpm verify` caught **3 failing integration tests** that had shipped inside
  the collected contribution work. Root-caused, fixed, committed (`99624c1`),
  and pushed. Full suite is green (358 files / 4682 tests) and `origin/main` is
  up to date.
- **Two follow-on items remain unimplemented** (see Open Work below):
  *collect-on-approve* and *new-contribution-after-submission*. A third,
  smaller cleanup — the legacy path's `invocationKind: "new_run"` tag — is
  noted under Known Nuances.

---

## What shipped this session

### 1. Verified reply continuity (behavior confirmed, already in `main`)

Replying to an existing leader session resumes the same SDK run rather than
spawning a new one. The chain:

- `server/commands/send-message.ts:125` — `resumeLeader()` passes
  `resumeId: host.sessionId ?? undefined` into `ctx.registry.start(...)`.
- `server/session-host.ts:263` — `start()` sets `this.sessionId = opts.resumeId`
  when present.
- `server/harness/claude/index.ts:203` — the Claude harness passes
  `resume: opts.resumeId` into the SDK query options, so the provider resumes
  the existing thread (history/context preserved).

### 2. Fixed 3 red integration tests (commit `99624c1`)

- **Files:** `server/worktree.integration.test.ts`,
  `server/git-integration-worker.integration.test.ts`.
- **Root cause:** both built bare temp git repos with no `.gitignore`, so the
  untracked `.canvas-worktrees/` worktree directory registered as "uncommitted
  changes" in the target checkout. That made the merge dirty-check
  (`server/worktree-merge.ts:44`) and the promote dirty-guard
  (`server/git-integration-executor.ts:126`) short-circuit to failure /
  `waiting` — failing 3 tests (`worktree.integration` merge; worker "reruns
  gates after a moved target"; worker "blocks promotion on failing gates").
- **Why it was a fixture bug, not a regression:** production repos gitignore
  `.canvas-worktrees/` (`.gitignore:23`), so `dirty(checkout)` correctly
  ignores them. The tests simply didn't replicate that setup.
- **Fix:** write `.gitignore` containing `.canvas-worktrees/` into both test
  fixtures before the initial commit. No production code changed.

### 3. Pushed `main` → `origin/main`

24 commits (the collected contribution work + reply-continuity fix + the test
fix) are now on `origin/main`. Working tree clean; temp verification worktree
removed.

---

## Open work (not implemented)

These were on the prior plan and remain **unstarted**:

| Item | State | Where it lives |
|---|---|---|
| **Collect on approve** — collection should happen at approval time | NOT done. Collection currently fires when a run reaches terminal (`server/work-item-runtime-lifecycle.ts:97` → `collectWorktreeRun`), *before/without* approval. Approval (`server/commands/helpers.ts` `continueMergeFlow`) clears approval state but does not trigger collection. | `work-item-runtime-lifecycle.ts`, `commands/helpers.ts`, `commands/approve-changes.ts` |
| **New contribution after submission** — create a fresh contribution/run after a prior one is submitted | NOT done. No `allocateRun`/`planNextContribution`/`nextRun` path exists. Users manually start a new session/run. | `commands/approve-changes.ts`, `work-item-runtime-lifecycle.ts` |

## Known nuances (important for the next leader)

- **Two send paths.** `send-message.ts` branches on `host.workItemId`:
  - **Canonical work-item runtime** (`workItemId` set): routes through
    `ctx.workItems` — `replyToWaitingRun(...)` when the run is waiting on a
    decision, or `startRun(...)` when inactive/draft (`send-message.ts:47-83`).
  - **Legacy `resumeLeader` path** (no `workItemId`): the `resumeId` resume
    described above (`send-message.ts:111-168`).
  When reasoning about continuity, confirm which path a given session is on.
- **Legacy path still tags `invocationKind: "new_run"`.** Even though the SDK
  thread resumes via `resumeId`, the legacy path records the turn as a new run
  (`send-message.ts:119-122`), pending "Phase 1 persistence [that] can
  distinguish terminal from open runs." Continuity is correct at the SDK level;
  the persistence tag is the remaining cleanup.
- **Follow-up after approval/discard makes a fresh worktree.** If a leader has
  worktree isolation on but no live worktree (post-merge/discard), a new
  worktree is provisioned before resume (`send-message.ts:134-168`,
  `needsNewWorktree`).
- **Mid-thread harness switching is intentionally unsupported** — a Claude
  conversation will not silently flip to Codex on a follow-up
  (`send-message.ts:112-116`).

---

## Verification checklist for the next leader

1. `git status` clean, `git log origin/main..HEAD` empty (in sync).
2. `pnpm verify` green before any push (it is, as of `99624c1`).
3. The dirty-check fixture pattern: any new integration test that provisions a
   worktree under `.canvas-worktrees/` must gitignore that path in its temp
   repo, or the dirty-guards will report false positives.
