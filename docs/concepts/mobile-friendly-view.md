# Concept: Mobile-Friendly Minions ("Focus View")

> Status: **Concept / exploration** — not yet implemented.
> Companion artifact: [`mobile-mockup.html`](./mobile-mockup.html) (open in a phone-sized browser window or device emulator).

## Problem

Minions is an infinite canvas designed for a mouse + large screen: pan, zoom,
drag-to-connect, spatial layout. On a phone this falls apart:

- The custom transform canvas (`src/Canvas.tsx`) has **no touch handling** — no
  pinch-zoom, no two-finger pan, no touch-drag.
- Even with touch, an infinite 2D plane is a poor fit for a 390px-wide screen.
  You spend all your time navigating instead of reading the one session you care
  about.
- The most common mobile job-to-be-done is **monitoring + light steering**:
  "what are my agents doing, are any blocked/waiting on me, let me reply to one."
  That's a feed/list job, not a spatial-canvas job.

## Why a new view (not touch-on-canvas)

Two facts from the codebase make a dedicated mobile view the cheap, high-leverage
option:

1. **State is view-agnostic.** `canvas-state.ts` (`canvasReducer`) and
   `graph-runtime.ts` (`graphReducer`) hold nodes/edges independent of how they're
   drawn. The WebSocket bus (`use-socket.ts`) streams the same `sdk_event` /
   `session_status` updates regardless of view.
2. **There's already a precedent.** `App.tsx` toggles `activeView: "canvas" |
   "kanban"`, and `kanban.css` already ships responsive breakpoints
   (`≤768px`, `≤480px`) and touch tokens (`--kb-touch-min: 44px`). A third view
   slots into the same switch.

So: **add `activeView: "focus"`** rather than retrofitting touch onto the canvas.
Desktop canvas is untouched; phones get a purpose-built surface.

## The Focus View

Three screens, navigated like a native app (list → detail → compose).

### 1. Session list (home)
A vertical, scrollable stack of all sessions in the project — one card per
leader/minion/claude-session node.

Each card shows, at a glance:
- Status dot (`--status-running` / `success` / `waiting` / `error` …) + label
- Title + the latest streaming line (live, truncated)
- A badge when the session **needs you** (waiting on input / question / approval)
- Model chip, last-activity timestamp

Sorting: **needs-you first**, then running, then idle. This makes the "anything
blocked?" question answerable in one glance — the whole point of mobile.

Top bar: project name + switcher, connection status, a "+" to start a leader.

### 2. Session detail (full-screen chat)
Tap a card → full-screen conversation for that session. Reuses the same
`DisplayMessage[]` stream (`sdk-messages.ts`) the LeaderNode/ClaudeSessionNode
already render — just in a single-column, full-bleed layout instead of inside a
canvas node.

- Sticky header: back, title, status, kebab (stop / view tasks / open on canvas).
- Message feed: user/assistant/tool/thinking blocks, same semantics as desktop.
- If the session spawned minions, a collapsible "Subagents (N)" strip lets you
  jump between them without going back to the list.

### 3. Compose / steer
Sticky bottom input (the dominant mobile interaction): send a message, answer a
question form, approve/deny a worktree change. These map to existing WS commands —
nothing new server-side.

## Navigation model

```
┌── Session list ──┐   tap card    ┌── Session detail ──┐
│  needs-you first │ ─────────────▶│  full-screen chat  │
│  running         │ ◀───────────── │  + compose bar     │
│  idle            │     back       └────────────────────┘
└──────────────────┘
        ▲
        │ optional: same data also reachable as the existing Kanban view
```

A bottom tab bar can later expose: **Sessions · Tasks (kanban) · Canvas (read-only
preview)**. v1 can ship with just Sessions + Tasks.

## How it routes

`src/App.tsx` (the shell) picks the view:

- **Phone (`≤768px`)**: default to `focus`. Canvas/Kanban still reachable from a
  menu, but Focus is home.
- **Tablet / desktop**: unchanged — canvas stays the default; Focus is an opt-in
  view in the same switcher.

Detection via a small `useViewport()` hook wrapping `matchMedia("(max-width:768px)")`
(no library; mirrors how kanban.css already uses 768px).

## Implementation sketch (Direction A, v1)

| Area | File(s) | Change |
|---|---|---|
| Viewport detection | `src/use-viewport.ts` *(new)* | `matchMedia` hook → `isPhone` |
| View switch | `src/App.tsx` | add `"focus"` to `activeView`; default to focus on phone |
| Focus shell | `src/focus/FocusView.tsx` *(new)* | list ↔ detail routing, top bar |
| Session list | `src/focus/SessionList.tsx` *(new)* | cards from `canvasReducer` nodes, sorted needs-you-first |
| Session card | `src/focus/SessionCard.tsx` *(new)* | status dot, live last-line, needs-you badge |
| Session detail | `src/focus/SessionDetail.tsx` *(new)* | reuse `DisplayMessage[]` feed + compose bar |
| Styling | `src/focus/focus.css` *(new)* | reuse `index.css` tokens + kanban responsive patterns |
| Derivation | `src/focus/select-sessions.ts` *(new, pure)* | nodes+status → sorted session summaries |

**Reuses (no change):** `use-socket.ts`, `canvas-state.ts`, `graph-runtime.ts`,
`sdk-messages.ts`, `streaming.ts`, theme tokens, and all WS commands.

### Tests (per `CLAUDE.md` — same commit as the change)
- `src/focus/select-sessions.test.ts` — pure: sorting (needs-you first), status
  mapping, last-line extraction. *Write first.*
- `src/use-viewport.test.ts` — `matchMedia` mock → breakpoint transitions.
- `src/focus/SessionList.test.tsx` — RTL: renders cards, needs-you ordering,
  tap → detail callback.
- `src/focus/SessionDetail.test.tsx` — RTL: renders feed, compose sends WS command.
- Architecture: new `server/` files n/a (frontend only); keep components small.

## Effort & risk

- **Effort:** ~Low-Medium. The hard parts (state, streaming, message rendering,
  WS commands) already exist and are reused. New work is presentational + routing.
- **Risk:** Low. Additive — desktop canvas untouched; new view behind the
  existing `activeView` switch.
- **Out of scope for v1:** touch-enabling the canvas (Direction B), offline,
  push notifications, gesture nav. Natural follow-ups.

## Open questions for product

1. On phone, is Focus the **default** (canvas demoted to a menu item), or just an
   available view?
2. v1 scope: Sessions list + detail only, or also include the (already-responsive)
   Kanban as a tab?
3. Should the detail view allow **starting new minions** from mobile, or is mobile
   monitor-and-steer only?
