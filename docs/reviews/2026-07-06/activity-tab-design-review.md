# Activity Tab — Holistic Design Review

_2026-07-06 · surface: `src/ActivityView.tsx` + `src/activity.css`, header tab in
`src/ProjectHeader.tsx`, data via `useSessionActivity` / `mobile-selectors.ts`._

---

## 1. What the tab is today

The Activity tab is the **default landing view** (`activeView` defaults to
`"activity"` in `App.tsx`) and one of three top-level surfaces:
**Activity · Canvas · Kanban**. It is the desktop mirror of the mobile Activity
screen and reuses the same `groupSessionsByActivity` selectors.

Layout:

- **Header** — title "Activity", a total count pill, and a **Launch** button.
- **List (left, fluid grid)** — session cards grouped into three sections in
  fixed order: **Active → Idle → Stopped/Cleared**. Minions are filtered out
  (top-level sessions only). Within a section, cards sort by recency, then
  attention, then title.
- **Card** — role, status pill, title, `cost · turns · model`, last-activity
  line, and a footer with relative time + `changes` / `on canvas` tags.
  Attention (error / pendingAttention) tints the card amber.
- **Inspector (right, fixed 400px)** — opens on card select: status, a 2×2
  metric grid (cost / turns / model / harness), action buttons
  (Open in Canvas, Expand fullscreen, Attach to canvas, Stop), an inline
  **Changes** review panel when the leader has reviewable worktree changes, and
  a read-only live **transcript**.
- **Tab badge** — `activityAttentionCount + changesCount` shows a red badge on
  the Activity tab in the header.

The status taxonomy (8 statuses) collapses into 3 buckets: active =
{running, creating, waiting}, stopped = {stopped, completed, disconnected},
idle = everything else **including `error`**.

---

## 2. Core Jobs To Be Done

Minions is an infinite canvas fronting many parallel agents. The Activity tab is
the **flat, non-spatial control surface** over those agents — mission control /
an inbox. Framed as jobs the user "hires" this tab to do:

| # | Job to be done | The underlying need |
|---|----------------|---------------------|
| 1 | **Triage** — "What needs *me* right now?" | Find blocked / waiting / errored / changes-ready sessions and act, fast. |
| 2 | **Awareness** — "What's happening across all my agents?" | A glanceable read of running / idle / done, cost, progress. |
| 3 | **Inspect** — "Show me this session's state." | Read the transcript, cost, model; understand what it did. |
| 4 | **Act / steer** — "Do something about it." | Review & merge changes, reply, stop a runaway, launch. |
| 5 | **Navigate** — "Get me to the right place." | Bridge the flat list to the spatial canvas / fullscreen cockpit. |
| 6 | **Launch** — "Start new work." | An entry point to spawn a leader. |

Priority order for a multi-agent operator: **1 and 4 are the highest-value jobs**
(the human-in-the-loop moments), 2 supports them, 3/5/6 are table stakes.

---

## 3. How well the current design serves each job

### JTBD 1 — Triage · **Weak**
- Attention items are **not pulled together**. An errored session lands in the
  "Idle" bucket and is sorted only *second* (after recency) within it — so a
  stale error can sit below fresh running cards. The user must scan every
  section to find "what needs me."
- **"Changes ready to review" is buried.** Reviewing/merging worktree changes is
  arguably *the* central human action, yet it surfaces only as a tiny `changes`
  tag in the card footer and inside the inspector. It is counted into the tab
  badge but has no dedicated lane.
- **No attention taxonomy.** error vs waiting-for-input vs changes-ready all
  collapse to one amber highlight. These demand different responses.
- Semantic contradiction: an urgent errored session is displayed under a section
  literally titled **"Idle."**

### JTBD 2 — Awareness · **Weak**
- Header shows only a total count. No breakdown (running N · idle N · needs-you N),
  no aggregate cost roll-up, no throughput/time sense — despite cost being
  tracked per session.
- No timeline or progress signal; "last activity" is per-card text only.

### JTBD 3 — Inspect · **OK**
- Inspector is solid: metrics + inline changes + live transcript.
- But the transcript is **read-only** — you cannot steer from here; you must
  "Expand fullscreen." The triage surface can't resolve the triage.
- Single-select only; no compare across sessions.

### JTBD 4 — Act / steer · **Partial**
- Good: Open in Canvas, Expand fullscreen, Attach, Stop, inline Changes review.
- Gaps: **no inline reply/steer**; no per-card Stop (running runaway needs a
  select → inspector → Stop detour); no bulk actions (Stop all, Clear stopped);
  clearing stopped sessions isn't discoverable despite the "…/Cleared" label.

### JTBD 5 — Navigate · **Good**
- The `sessionKey → leader node` index genuinely bridges list ↔ canvas ↔
  fullscreen. Minor: the spatial relationship is only a faint "on canvas" pill.

### JTBD 6 — Launch · **Good**
- Launch button + empty-state CTA. Fine.

### Cross-cutting craft notes
- **Card hierarchy is flat.** 6 rows in 128px at near-uniform weight; the
  decision-relevant signal (needs-you / has-changes / waiting) doesn't dominate.
- **Desktop parity gap.** Mobile shows notice banners (session-limit, reconnect);
  desktop `ActivityView` surfaces no notices, no reconnect/loading state, no
  manual refresh — even though `risk.session_state_drift` is called out in the
  system model. It fires `list_sessions` on entry then trusts the live stream.
- **No keyboard nav / deep-link** to a session.

---

## 4. Design options (directions)

Three coherent directions, orderable as a layered roadmap rather than
either/or. Each maps to the jobs it most advances.

### Direction A — "Triage Inbox" _(recommended first move)_
Reframe Activity as an **inbox**. A pinned top section — **"Needs you"** —
aggregates *everything requiring a human*, independent of running/idle state:
errors, waiting-for-input, and changes-ready-to-review. Each row carries a
single primary resolve action (**Review**, **Reply**, **Retry**, **Stop**).
Below it, collapsed **"Working"** and **"Idle / Done"** lanes.

- Serves: **JTBD 1, 4** (highest value).
- Cost: medium — new sectioning + a "needs attention" predicate that unions
  error ∪ pendingAttention ∪ hasReviewableChanges (all already computable).
- Tradeoff: departs from strict mobile parity; the shared selector grows a
  fourth conceptual bucket (attention as a cross-cut, not a status class).

### Direction B — "Mission Control summary"
Keep the grouped list but add a **summary strip** under the header:
`running N · idle N · needs-you N · changes N · $cost total`, plus a small
activity sparkline/timeline. Make attention its own **pinned lane** and give the
three attention kinds distinct colors (error = red, waiting = amber,
changes = accent/green).

- Serves: **JTBD 2**, reinforces 1.
- Cost: low–medium; mostly additive, low risk.
- Tradeoff: adds chrome; must stay glanceable, not a stat wall.

### Direction C — "Inline cockpit"
Make the inspector **fully interactive**: reply/steer the agent, approve/merge
changes, adjust model — so the entire triage → resolve loop happens without
leaving Activity or expanding fullscreen.

- Serves: **JTBD 3, 4**.
- Cost: higher — reuses fullscreen cockpit send-path + changes-merge command in
  a narrower shell; most engineering-heavy.
- Tradeoff: risks duplicating the fullscreen cockpit; scope the inline surface
  to reply + approve, defer the rest to fullscreen.

**Recommended sequencing:** B (cheap awareness + attention colors) → A (the
"Needs you" lane, the biggest triage win) → C (inline reply/approve).

---

## 5. Quick wins (low effort, high value)

1. **Pinned "Needs you" section** unioning error ∪ pendingAttention ∪
   reviewable-changes, above Active/Idle/Stopped.
2. **Summary counts in the header** (running / idle / needs-you / total cost).
3. **Elevate "changes"** from a footer tag to a primary card affordance with a
   direct **Review** button.
4. **Differentiate attention colors** by kind (error / waiting / changes).
5. **Per-card Stop** for running sessions (no inspector detour).
6. **Desktop notice + reconnect/refresh** for parity with mobile and to address
   `risk.session_state_drift`.
7. **Rename the catch-all** so errored sessions never read as "Idle."

---

## 6. Testing note

Per repo policy, any change here lands with tests: selector logic in
`src/mobile/mobile-selectors.test.ts`, component behavior in
`src/ActivityView.test.tsx`, and mobile parity in the mobile Activity tests.
