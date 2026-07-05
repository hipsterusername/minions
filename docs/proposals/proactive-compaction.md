# Proposal: Proactive Compaction Checkpoints for Leader Sessions

Status: PROPOSED (design only — no implementation yet)
Depends on: per-turn usage telemetry (`session_usage`, shipped), frozen leader prompt prefix (shipped)

## Problem

Compaction today exists only as *error recovery*: `server/session-host-context-recovery.ts`
fires after a context-window failure, rebuilding a fresh thread from capped excerpts
(24k-char recovery prompt, 14k recent events, 8k original prompt). This is the most
expensive possible policy:

1. The failing turn is fully paid for before it fails.
2. Sessions that hit the limit are by definition the largest contexts — they paid
   escalating replay cost the whole way up (a 900k-token leader pays ~$0.90 per warm
   wake on Fable 5, ~$9.00 per cold one, before doing any work).
3. Emergency reconstruction from truncated excerpts loses more state than a deliberate
   checkpoint taken calmly, because the model never gets to write its own handoff.
4. Fable 5 exhibits documented "context anxiety" deep into very long sessions;
   proactive compaction keeps sessions out of that zone.

## Key architectural insight

Most leader state is already **server-authoritative**, not model-memory:

| State | Owner | Survives a thread swap? |
|---|---|---|
| Task registry (planned/running/completed, results) | server task store | yes — re-injectable |
| Render dashboard tree | server render state | yes — UI unaffected; model only needs component ids |
| Reasoning map | server MCP state | yes |
| Worktree / branch / approval state | server | yes |
| System prompt | frozen per session (Phase 2) | yes — byte-identical reuse |
| Conversational intent: decisions made, dead ends, what's next | **model memory only** | **no — this is the only thing a handoff must capture** |

So a checkpoint does not need to summarize the whole conversation. It needs one
bounded, model-authored handoff of *intent*, plus mechanical re-injection of
server-held snapshots.

## Design

### 1. Trigger — telemetry-driven, with hysteresis

The new `session_usage` rows give per-turn `input + cacheRead` ≈ current prompt size.
A small detector (`server/compaction-advisor.ts`) evaluates after each usage event:

- `RECOMMEND_THRESHOLD`: context ≥ 55% of the model's context window (from model
  metadata; 1M for Fable 5 / Opus-tier) → session marked `compaction: recommended`.
- `FORCE_THRESHOLD`: ≥ 80% → auto-checkpoint at the next safe boundary (fallback if
  the model ignores the recommendation).
- Armed once per crossing (hysteresis) — no re-nagging every turn.

### 2. Mechanism — hybrid: server detects, model hands off, server rebuilds

**Recommend phase.** On the next wake, the server appends a compact system-reminder to
the wake prompt: *"Context at 62% of window. Call `checkpoint_session` at the next
safe boundary (no in-flight integration) to continue in a fresh thread at ~5% of
current replay cost."* One sentence — the reminder itself is prefix-suffix, not
prefix-mutating, so it does not break the cache.

**Checkpoint tool.** New leader MCP tool `checkpoint_session` (server/task-tools/):

1. Server validates safe boundary: no pending form, no pending approval, no
   mid-merge worktree op. If unsafe → tool returns "deferred: <reason>".
2. The tool result instructs the model to emit a structured handoff as its next
   output (goal, decisions + rationale, dead ends, open threads, next steps;
   hard cap ~4,000 chars, truncated at read).
3. Server assembles the seed prompt for a **fresh SDK thread** (no `resumeId`):
   - the session's frozen system prompt, byte-identical (cheap prefix re-write,
     then cached again);
   - `<previous-session-context>` built from **server state**: task registry
     snapshot (ids, titles, statuses, capped result summaries), dashboard component
     inventory (ids/types only — the tree survives server-side),
     worktree/branch info;
   - the model-authored handoff verbatim.
4. Host swaps `sessionId` to the new thread; the old thread id is retained on the
   session record for audit. Wake triggers arriving mid-swap are held (the
   wake-coalescer deferral path), never dropped.
5. UI: a `session_compacted` event renders a marker in the transcript
   ("— context checkpointed: 640k → 38k tokens —"). Contract test required
   (new WS event ⇒ `tests/contracts/`).

**Why not fully-automatic-only:** the one thing the server cannot snapshot is what
the model *was about to do*. Letting the model write its own handoff at a boundary it
chose is materially better than server-side excerpting (which is exactly what the
error-recovery path does, and why it's lossy). The 80% auto-fallback bounds the
downside if the model never calls the tool.

**Why not the API's server-side compaction beta:** the Agent SDK owns the message
loop here, and the existing frozen-prefix + resume architecture already gives cheap
warm wakes; a thread swap under our own control preserves the task/render/reasoning
re-injection invariants explicitly rather than trusting an opaque summary block.
Revisit if/when the SDK exposes compaction natively.

### 3. Cost analysis (Fable 5, session at 600k tokens)

| | Cost |
|---|---|
| Handoff turn (~3k output) | ~$0.15 |
| Cold seed of new thread (~35k input + cache write) | ~$0.35 + $0.44 |
| **Checkpoint total** | **~$0.95 one-time** |
| Continuing instead: each warm wake | ~$0.60 |
| Continuing instead: each cache-lapsed wake (>5 min gap) | ~$6.00 + $7.50 re-write |

Break-even in 1–2 wakes; any overnight/idle-gap session pays for the checkpoint on
its first cold wake avoided. Savings compound as the old context keeps growing.

### 4. Safety invariants

- Never checkpoint while: form pending, approval pending, worktree merge in flight,
  or children mid-`any_terminal` steering exchange.
- Wake signals during swap are deferred, never lost.
- Checkpoint failure at any step → session continues on the old thread untouched;
  error-path recovery remains the last resort. The old thread is never deleted.
- `checkpoint_session` is idempotent (second call while one is in flight → no-op).

### 5. Rollout

Project setting `proactiveCompaction: "off" | "recommend" | "auto"`, default
`"recommend"`. Telemetry dashboards (Phase 1) report how many sessions cross 55%,
which decides whether `"auto"` should become default.

### 6. Test plan

- Unit: threshold detector (crossing, hysteresis, per-model window), seed-prompt
  builder (caps, marker only when truncated, includes task snapshot), safe-boundary
  validator, swap state machine with fake host.
- Contract: `session_compacted` WS event shape.
- Architecture: new server files ≤ 400 lines; no cross-tree imports.
- Regression: error-path recovery unchanged (existing tests still pass untouched).

### Estimated effort

~2–3 focused minion-days: advisor + tool + seed builder are separable modules;
the risky part is the host thread-swap, which should reuse the existing
context-recovery swap mechanics rather than inventing new ones.
