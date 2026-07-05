# Mobile Experience — Concept Spec

Status: **Concept / RFC.** No code yet. This document proposes a
mobile-friendly experience for Minions and the path to build it. It is
grounded in the current architecture (see `docs/testing-strategy.md` for
the layering model and `CLAUDE.md` for the working agreement).

---

## 1. Thesis

> **The phone is a remote control for running agents, not a second canvas.**

Minions' core surface — the infinite canvas — is a *spatial authoring*
medium. You lay out leaders, wire context edges, drag nodes, and watch
work unfold across a 2D plane. That interaction model is mouse-and-
keyboard native and assumes a wide viewport. Faithfully porting it to a
4-inch touchscreen would fight the medium and produce something worse
than either platform.

The mobile opportunity is different. When you're away from your desk,
you don't want to *author* a complex graph — you want to **monitor,
steer, and approve** the work you already launched. The phone's job is:

- *"Is the refactor done? What did it touch?"* — **monitor**
- *"It went down the wrong path — redirect it."* — **steer**
- *"The diff looks right. Ship it."* — **approve**
- *"Quick: start a leader on the bug I just thought of."* — **launch**

So the mobile experience is a **purpose-built client over the existing
backend**, not a responsive retrofit of `Canvas.tsx`.

---

## 2. Why this is achievable now

The backend was, perhaps accidentally, already built for this. Findings
from the current architecture:

| Capability | Where | Why it matters for mobile |
|---|---|---|
| Tailscale remote access | `server/network-access.ts`, `vite.config.ts` (`allowedHosts: [".ts.net"]`) | A phone on the tailnet can already reach the server securely. No new transport needed. |
| WS reconnect w/ backoff | `src/use-socket.ts` (2s→30s, ±jitter, 10 retries) | Mobile networks drop constantly; reconnection is solved. |
| Event buffering | `server/session-host.ts` (`eventBuffer`, cap 500) + `event_log` table (`server/db.ts`) | A phone that was backgrounded can catch up via `sync_session`. |
| Resumable sessions | `server/session-persist.ts`, `sessions.session_id` | Survives server restart and client disconnect. |
| Topic-filtered envelopes | `shared/ws-envelope.ts` (`session:`, `project:`, `global`) | Mobile client can subscribe narrowly to save bandwidth. |
| Kanban view | `src/KanbanBoard.tsx`, `src/use-kanban.ts` | A *linear, list-based* representation already exists — a natural bridge to mobile layouts and message filtering logic we can reuse. |
| Headless state reducers | `src/session-stream.ts`, `src/canvas-state.ts`, `src/graph-runtime.ts` | Message/cost/status state is reducer-driven and UI-agnostic — reusable in a mobile shell without dragging in the canvas. |

What's genuinely missing is all on the **frontend**:

- No touch event handlers (pan/zoom/drag are pointer/mouse-only).
- No `viewport` meta tag or mobile layout strategy.
- Sidebars (`ProjectPanel`) and bottom docks (`BottomRightDock`) assume
  desktop width; their only "responsive" behavior is density tiers at
  1500/1700px (`useDockDensity`).
- Hardcoded node sizes (Leader 560×520, etc.).
- Context menus (`CanvasContextMenu`) assume hover/right-click.
- No push notifications for approvals.
- No PWA manifest / installability.

---

## 3. Primary use cases (ranked)

1. **Monitor running agents** *(anchor)* — a glanceable feed of every
   live leader/minion: status, cost, turn count, latest activity, and
   streaming output on tap. This is the most common "I'm away but
   curious" moment.
2. **Approve agent work** *(killer feature)* — get pushed an approval
   request, review the worktree diff, and **Approve & Merge** or
   **Request changes** from anywhere. Resumable across disconnects
   because approval state lives in the DB (`approval_json`).
3. **Steer a running agent** — reply to a leader that asked a question
   or wandered; redirect it with a message. Reuses `send_message`.
4. **Launch new work** — spawn a leader with a prompt + working dir in
   two taps. Reuses `create_session` / `send_message`.

Non-goals for v1: building/wiring the graph, multi-node marquee
selection, port-drag connections, render-dashboard authoring. The
canvas appears only as a **read-only minimap** for spatial orientation.

---

## 4. Screen-by-screen

### 4.0 Shell & navigation

- **Bottom tab bar** (thumb-reachable): **Activity · Approvals · Launch ·
  Map**. Approvals tab carries a badge count.
- **Bottom sheets** replace hover context menus (node actions, model
  pickers, confirmations).
- **Full-screen editors** replace inline textareas for composing
  messages and prompts.
- Honors `prefers-reduced-motion` and safe-area insets.

### 4.1 Activity (home)

The session feed. One card per active session, sourced from the
`session_list` snapshot on connect plus live `session_status` /
`sdk_event` updates.

Each card shows:
- Role + task name (leader/minion, `set_task_name` output).
- Status pill (running / idle / error / completed) — reuse the existing
  status color tokens.
- Live metrics: cost, turns, elapsed; a tiny activity sparkline.
- Last line of output (truncated), updating live from streaming deltas.
- Approval badge if this session is awaiting review.

Interactions: tap → Session detail. Pull-to-refresh re-syncs. Filter
chips: *Running · Needs me · All*.

### 4.2 Session detail (chat)

The heart of mobile. A full-screen chat feed reusing
`src/session-stream.ts` and the message-bubble components, with the
Kanban message-filtering rules (`KanbanBoard.tsx` hides plumbing tools,
groups consecutive tool calls into a single badge).

- **Streaming**: subscribe to `session:<key>`; render `streamingText`
  with the existing `StreamingBubble` / `StreamingIndicator`.
- **Tool activity**: collapsed by default ("Read, Edit, Glob ×3"),
  tappable to expand — keeps the feed scannable on a small screen.
- **Thinking**: collapsed `LeaderThinkingGroup`.
- **Composer**: sticky bottom input → full-screen editor on focus;
  supports image attachments (backend already accepts base64 up to
  32MB). Sends via `send_message`.
- **Header actions** (overflow → bottom sheet): Stop (`stop_session`),
  switch model (`set_model`), view diff / approval if pending.

### 4.3 Approvals inbox

The standout mobile flow. Driven by `approval_requested` events and a
push notification (§6).

- **List**: every session with `approval.requested === true`, summary +
  file-change count.
- **Detail**: fetch the diff on demand via `get_worktree_diff`
  (`control_response`, correlated by `requestId`). Render a mobile diff
  view — per-file collapsible hunks, additions/deletions colored. Cache
  locally to avoid re-fetching large diffs.
- **Actions** (sticky bottom bar):
  - **Approve & Merge** → `approve_changes`.
  - **Request changes** → opens composer; sends `send_message` (server
    wraps it as change-request feedback, clears approval).
  - **Discard** → `discard_worktree` (confirm via sheet).
- Resumable: if the phone was offline when the request fired, the state
  is still in `sessions.approval_json` and shows on next sync.

### 4.4 Quick launch

Minimal new-leader form:
- Prompt (full-screen editor).
- Working dir (recent projects from `~/.minions/recent-projects.json`).
- Optional: model, worktree isolation toggle.
- Submit → `create_session` then `send_message`; navigates to the new
  session's chat.

### 4.5 Canvas minimap (Map tab)

Read-only spatial orientation, not authoring. Reuse
`src/CanvasMiniMap.tsx` logic to render node positions as tappable dots
colored by status. Tap a node → its Session detail (or a read-only
preview for non-session nodes like markdown/file-viewer). Pinch to zoom
the *minimap only*; no node dragging, no edge editing.

---

## 5. Technical approach

Three options were considered:

| Option | Summary | Verdict |
|---|---|---|
| **A. Responsive retrofit** | Add media queries + touch handlers to `Canvas.tsx`, shrink nodes, convert docks to sheets. | ✗ Highest effort, fights the paradigm, bloats the files `CLAUDE.md` asks us to keep small (`Canvas.tsx`, `LeaderNode.tsx`). |
| **B. Dedicated mobile shell** | A separate mobile entry (device-detected or `/m` route) reusing `use-socket.ts`, `session-stream.ts`, message bubbles, and node registry — but its own layout components. Canvas appears only as a read-only minimap. | ✓ **Recommended.** Clean separation, reuses the valuable headless logic, leaves desktop untouched. |
| **C. PWA wrapper** | Manifest + service worker for install + push. | ✓ **Layer on top of B** — not an alternative. Required for approval push. |

**Recommendation: B + C.**

Architecture sketch:
- New route/entry `src/mobile/` with its own shell (`MobileApp.tsx`,
  tab bar, screens). Detect via viewport + `coarse` pointer media query,
  or explicit `/m` path; offer a "desktop site" escape hatch.
- Reuse without modification: `use-socket.ts`, `session-stream.ts`,
  message-bubble components, status/cost tokens from `index.css`,
  `CanvasMiniMap` (read-only mode).
- New, mobile-only: shell, tab nav, bottom sheets, mobile diff viewer,
  composer, approvals list.
- Backend additions (small): a Web Push registration endpoint + a hook
  on `approval_requested` to fan out a push. Everything else (commands,
  events, persistence) is unchanged.
- Add a `viewport` meta tag + PWA manifest + service worker.

### Testing (per `CLAUDE.md` — tests ship in the same commit)

- **Unit**: mobile message-filtering, diff-grouping, approval-state
  selectors — colocated `*.test.ts`.
- **Component**: `*.test.tsx` with `@testing-library/react` for the
  Activity card, chat composer, approval actions (query-based, no full
  DOM snapshots).
- **Contract**: any new WS surface (push registration) gets a test in
  `tests/contracts/`.
- **Architecture**: keep new `server/*.ts` under 400 lines; no
  cross-tree imports; no direct `broadcast()` outside the bus.

---

## 6. Approval push notifications

The single highest-leverage mobile capability.

1. Mobile PWA registers a Web Push subscription → new endpoint stores it
   (server-level `~/.minions/server.db`).
2. On `approval_requested` (emitted from the worktree/approval flow),
   the server sends a Web Push: *"Leader 'refactor auth' wants approval —
   4 files changed."*
3. Tapping the notification deep-links into the Approvals detail for that
   session.
4. Over Tailscale this stays within the trusted network; no public
   exposure required.

---

## 7. Security & access (carry forward, don't regress)

The current model is **single-user, local/Tailscale only** (random
per-startup token, `.ts.net`/loopback origin checks, no user model, no
TLS). Mobile access rides the same tailnet — this is acceptable for the
single-developer design and adds no new exposure. Explicit non-goals for
v1: public-internet access, multi-user auth, per-user session isolation.
If those are ever wanted, they're a separate, larger effort (OAuth/JWT,
TLS, ownership model) and should be specced independently.

---

## 8. Phased plan

- **Phase 0 — Foundations.** `viewport` meta, PWA manifest + service
  worker, mobile entry/route + device detection, bottom-tab shell.
- **Phase 1 — Monitor.** Activity feed + Session detail (read + stream).
  Reuses `session-stream`, message bubbles. *Delivers the anchor use
  case.*
- **Phase 2 — Approve.** Approvals inbox, mobile diff viewer, approve /
  request-changes / discard. *Delivers the killer feature.*
- **Phase 3 — Steer + Launch.** Composer with attachments; quick-launch
  form.
- **Phase 4 — Push.** Web Push registration + approval notifications.
- **Phase 5 — Map.** Read-only canvas minimap with tap-to-detail.

Each phase is independently shippable and leaves the desktop experience
untouched.

---

## 9. Open questions

1. **Entry model** — device-detected auto-redirect to `/m`, explicit
   route, or a single responsive app that swaps shells? (Leaning:
   detected, with a manual escape hatch.)
2. **Push transport** — Web Push (VAPID) over Tailscale, or a lighter
   in-app foreground-only notification for v1?
3. **Offline depth** — read-only cached view of the last sync when fully
   offline, or require connectivity?
4. **Minion visibility** — surface minions as their own Activity cards,
   or nest them under their leader?
5. **Scope of "steer"** — message-only in v1, or also model/permission
   changes from the phone?

---

## Appendix A — Wireframes

Low-fi sketches of the four screens that carry the experience. They
illustrate the §4 screen-by-screen spec; data sources are noted there.

### A.1 Activity (home) — the pager

```
┌─────────────────────────────────────┐
│ Minions            ● 3 running   ⚙   │  ← header status pill = fleet glance
├─────────────────────────────────────┤
│ ⚠ NEEDS YOU                          │
│ ┌─────────────────────────────────┐ │
│ │ ⛏ refactor-auth                 │ │  ← approval card, pinned top
│ │ Changes ready · 6 files +212 −48│ │
│ │ "Extracted token validation…"   │ │
│ │ [ Review ]      [ ✓ ]    [ ✕ ]  │ │  ← inline approve/discard
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ ⏸ data-export · minion blocked  │ │  ← blocked minion needs an answer
│ │ "Which date format for CSV?"    │ │
│ │ [ Answer ]                       │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ RUNNING            [Running·Needs·All]│  ← filter chips
│ ◎ refactor-auth      $0.42 · 12t  › │  ← live card, tap → chat
│   └ writing tests…           ⠋     │  ← last report_step + spinner
│ ◎ scrape-docs        $0.08 ·  3t  › │
├─────────────────────────────────────┤
│ DONE TODAY                           │
│ ✓ fix-flaky-test     $0.11        › │
└─────────────────────────────────────┘
│  ◎ Activity   ✓ Approvals①  ＋ Launch   ▦ Map │  ← bottom tab bar
```

### A.2 Session detail (chat) — watch & steer

The canvas node reframed as a chat thread — the one desktop pattern that
translates cleanly, since `session-stream.ts` is already message-oriented.

```
┌─────────────────────────────────────┐
│ ‹  refactor-auth        ◎ running ⋯ │  ← back · title · status · overflow
├─────────────────────────────────────┤
│ ▸ Task plan  3/5            ▰▰▰▱▱   │  ← collapsible plan strip → roster
├─────────────────────────────────────┤
│  You                                 │
│  Refactor the auth module to…        │
│         Leader                       │
│         I'll break this into 3…      │
│  ┌───────────────────────────────┐   │
│  │ 🔧 Read · Edit · Glob ×3      │   │  ← tool calls grouped → one line
│  └───────────────────────────────┘   │
│  ┌───────────────────────────────┐   │
│  │ ⛏ assign_task → write-tests › │   │  ← tap pushes the minion's thread
│  └───────────────────────────────┘   │
│         ⠋ writing token tests…       │  ← live streaming delta
├─────────────────────────────────────┤
│ [ Message refactor-auth…    ] [ ➤ ] │  ← sticky composer, always visible
│ [ ⏹ Stop ]                           │
└─────────────────────────────────────┘
```

### A.3 Review changes — the decision screen (killer flow)

Full-height takeover. Diff from `get_worktree_diff`; buttons map 1:1 to
existing WS commands.

```
┌─────────────────────────────────────┐
│ ✕                 refactor-auth      │
├─────────────────────────────────────┤
│ Changes ready for review             │
│ "Extracted token validation into a   │
│  pure module and added 14 tests."    │
│ 6 files · +212 −48 · 3 commits       │
├─────────────────────────────────────┤
│ ▾ src/auth/token.ts      +84 −12     │  ← per-file collapsible hunks
│   │ + export function verify(    │   │
│   │ −   legacyVerify(token)      │   │
│ ▸ src/auth/token.test.ts +98 −0     │
│ ▸ server/session-host.ts +12 −4     │
├─────────────────────────────────────┤
│ [ ✓ Approve & Merge ]                │  → approve_changes
│ [ ↩ Request changes ] [ ✕ Discard ] │  → send_message / discard_worktree
└─────────────────────────────────────┘
```

On conflict, a follow-up sheet surfaces `force_merge` / `theirs_merge` /
`retry_merge` — shown only when a conflict actually occurs.

### A.4 Blocked-minion answer sheet

Bottom sheet from an Activity card or a plan row → `message_task`.

```
        ┌─────────────────────────────┐
        │ ⏸ data-export is blocked    │
        │ "Which date format for the  │
        │  CSV — ISO 8601 or US?"     │
        │ ┌─────────┐ ┌─────────────┐ │  ← quick-reply chips when the
        │ │ ISO 8601│ │ US 06/27/26 │ │     question is multiple-choice
        │ └─────────┘ └─────────────┘ │
        │ [ Type an answer…      ] ➤  │
        └─────────────────────────────┘
```

---

## Appendix B — Interaction translation

How each desktop job re-maps to touch. Spatial navigation (X/Y position)
becomes hierarchical navigation (list → thread → detail); the leader's
`taskPlan[]` and session graph already encode the relationships, so no
coordinates are needed to render the tree.

| Job | Desktop | Mobile |
|---|---|---|
| See everything | Zoom-to-fit canvas | Activity feed |
| Open a session | Click node | Tap feed row → chat |
| Navigate leader→minion | Follow edge / "reveal" | Tap spawned-minion line → push thread |
| Send prompt | Textarea (hidden when zoomed in) | Sticky composer, always visible |
| Watch streaming | Read node body | Read thread (same reducer) |
| Inspect tool call | Expand inline group | Tap grouped one-liner → expand |
| Approve changes | Approval dashboard | Review-changes takeover |
| Unblock minion | Relay through leader | Quick-reply sheet → `message_task` |
| Context menu | Right-click | Long-press / `⋯` → bottom sheet |
| Stop work | Toolbar/menu | Pinned Stop in thread |
| Multi-select / marquee | Click-drag rectangle | — (not needed in feed model) |
| Connect nodes | Drag 6px port to port | — (edges implied by hierarchy) |
| Switch project | Project list | Projects/Launch entry |

### Desktop-only patterns and their fate

| Desktop pattern | Why it breaks on touch | Resolution |
|---|---|---|
| Drag-to-connect edges (6px ports) | Fingers ≈44px; precision drag on a zoomed plane is hostile | Edges implied by leader→minion→context hierarchy |
| Right-click menus | No right-click | Long-press / explicit `⋯` |
| Hover-only controls (copy, resize, ports) | No hover state | Always-visible or in a sheet |
| 3-column fixed chrome | No room < ~1024px | Single column + tab bar + sheets |
| Pinch/wheel zoom to navigate content | Fiddly on a phone | Replaced by list → thread → detail drill-down |
