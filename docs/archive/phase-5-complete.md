# Phase 5 Complete — SessionHost Refactor + Final Cleanup

**Completed:** 2026-04-21
**Commits:** `110d96f` (5.1) → `38f581b` (5.2) → `50cf064`, `88c0042`, `44ff946` (5.3)

Phase 5 was the final phase of the Minions canvas architecture refactor. The
goal was to drain `server/index.ts`, introduce `SessionHost`, and retire the
remaining entries on the file-size allowlist.

---

## What Shipped

### Sub-PR 5.1 — Extract `SessionHost`

Pulled per-session lifecycle out of `server/index.ts` into a dedicated class.

**New files:**
- `server/session-host.ts` (321) — `SessionHost` class: abort controller,
  SDK query handle, event buffer, task/render state, wait timer, worktree
  handle, SQLite write-through persistence.
- `server/session-host-config.ts` (159) — shared types, model-alias
  resolution, system-prompt worktree addendum.
- `server/session-host-run.ts` (275) — `ensureWorktree`,
  `buildQueryOptions`, `processSdkMessage` — the parts of `start()` big
  enough to warrant their own home.
- `server/session-registry.ts` (187) — typed `Map<string, SessionHost>`
  wrapper, boot hydration from SQLite, `session_list` snapshot helper.

**`server/index.ts`:** 2,065 → 1,460 lines (−605).

### Sub-PR 5.2 — Split the WS Command Dispatcher

Replaced the 1,100-line `switch (cmd.type)` with a typed command table.

**New directory:** `server/commands/` (25 files)
- `types.ts` — `WsCommand`, `WsCommandType`, `CommandContext`,
  `CommandHandler`, `CommandTable`.
- `helpers.ts` (203) — `getSessionOrError`, `sendControlResponse`,
  `sendControlError`, `runQueryOp` (collapses info-query handlers),
  `runMergeFlow` (shared flow for approve/force/theirs/retry merge).
- 22 per-command handler files under 100 lines each.
- `index.ts` — `COMMAND_TABLE` (`Readonly<Record<WsCommandType,
  CommandHandler>>`) + `dispatchCommand()`.

**New test:** `tests/contracts/command-table.test.ts` — enum-exhaustiveness
test guaranteeing every `WsCommandType` has a handler.

**`server/index.ts`:** 1,460 → **243 lines** (−1,217 cumulative from Phase 5
start). Now just REST wiring, WS construction, registry glue, and the
shutdown hook.

### Sub-PR 5.3 — Drain the Allowlist

Removed every remaining entry from `SERVER_FILE_SIZE_ALLOWLIST`.

- **`server/worktree.ts`** (646 → 30) split into:
  - `worktree-types.ts`, `worktree-exec.ts`, `worktree-create.ts`,
    `worktree-merge.ts`, `worktree-diff.ts` + barrel.
- **`server/task-tools.ts`** (624 → 96) split into `server/task-tools/`:
  - `types.ts`, `shared.ts`, `plan-task.ts`, `assign-task.ts`,
    `complete-task.ts`, `get-task-status.ts`, `wait-and-continue.ts`,
    `set-task-name.ts`, `request-approval.ts` + barrel.
- **`server/routes/projects.ts`** (596 → 16) split into
  `server/routes/projects/`:
  - `core.ts`, `files.ts`, `settings.ts`, `helpers.ts` + barrel.

`SERVER_FILE_SIZE_ALLOWLIST` is now `{}` — every server file is under the
400-line ceiling. The hard limit is the default for every new file going
forward.

### Sub-PR 5.4 — Cleanup + Release Notes

- Audited the ~80 `canvas/leader-*` branches. Two carry unmerged work:
  - `canvas/leader-mnw4a4ty` — real fix (`9a03123`: wheel scroll capture).
  - `canvas/leader-mo2b9y76-step4` — chain of auto-commit merges only; no
    user-visible work.
- Pruning decision deferred to the user. Suggested commands:
  ```bash
  # Prune worktrees with no diff from main
  git worktree list | awk '/canvas\/leader/ {print $1}' | while read p; do
    branch=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ "$(git log --oneline main..$branch 2>/dev/null | wc -l)" = "0" ]; then
      git worktree remove --force "$p" 2>/dev/null
      git branch -D "$branch" 2>/dev/null
    fi
  done
  # Keep canvas/leader-mnw4a4ty until the wheel-scroll fix lands on main.
  ```
- This retrospective (`docs/phase-5-complete.md`).

---

## Metrics

| Metric | Phase 4 exit | Phase 5 exit | Δ |
|---|---:|---:|---:|
| `server/index.ts` lines | 2,065 | 243 | −1,822 |
| `server/worktree.ts` lines | 646 | 30 | −616 (moved) |
| `server/task-tools.ts` lines | 624 | 96 | −528 (moved) |
| `server/routes/projects.ts` lines | 596 | 16 | −580 (moved) |
| Allowlist entries | 4 | 0 | −4 |
| Total tests | 422 | 566 | +144 |
| Test files | 27 | 28 | +1 |
| Typecheck (frontend) | clean | clean | — |

---

## What's Left (Non-blocking)

1. **Worktree pruning** — the two branches above are real, the other ~71
   are merged and safe to remove. Left to the user per safety protocol.
2. **`git push origin main`** — 10 local commits ahead of origin from
   Phases 2 → 5 have not been pushed. Left to the user.
3. **Optional `session-host.test.ts`** — existing harness coverage
   exercises the host through its WS surface; a dedicated lifecycle
   unit test is nice-to-have but not load-bearing.

---

## Working Agreement Going Forward

With the drain complete:

- **New server files must be under 400 lines**, enforced by
  `tests/architecture/file-size.test.ts`. If a file needs to grow, split
  it; don't add it to an allowlist (the allowlist is now a historical
  artefact).
- **New WS commands** are a single file under `server/commands/` + an
  entry in `COMMAND_TABLE`. The enum-exhaustiveness test will fail loudly
  if you add a `WsCommandType` without a handler.
- **Session lifecycle** is owned by `SessionHost`. Don't bypass it — add a
  method to the host rather than mutating session fields from outside.
- **Outbound WebSocket traffic** goes through `bus` only
  (`no-direct-broadcast.test.ts` enforces this).

---

## Related Docs

- `docs/architecture-review-2026-04-16.md` — the original architecture
  audit that drove phases 0–5.
- `docs/refactor-test-plan.md` — per-phase test targets.
- `docs/testing-strategy.md` — layer definitions, mocking boundaries.
