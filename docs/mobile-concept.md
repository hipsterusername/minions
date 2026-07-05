# Minions on Mobile — Concept

> Status: concept / discussion draft. No code changes implied yet.
> Grounded in the current architecture (custom canvas in `src/Canvas.tsx`,
> WS+JSON event bus in `server/bus.ts`, server-side SQLite persistence).

---

## 1. The reframe: a companion, not a canvas port

The desktop experience is an **infinite spatial canvas** — a place to *author*
arrange work in space. That is a precision, large-screen, mouse-driven activity.
Cramming a pannable 660px-wide node graph onto a 390px phone fights the medium
and loses.

The thing that *is* a perfect fit for mobile is the **other half** of Minions:
agents run autonomously for minutes-to-hours, and the human's job between
authoring sessions is to **monitor, steer, decide, and approve**. That is
inherently a glance-and-tap, notification-driven, one-thread-at-a-time activity.

So the concept is:

**Minions Mobile is a companion control surface for work you set up on desktop —
optimized for watching minions, answering their questions, nudging the leader,
and approving results, with push notifications as the spine.**

Authoring stays on desktop. The phone is the pager + remote.

---

## 2. Design principles

1. **One thread at a time.** No spatial multiplexing. The user is always looking
   at exactly one session, dashboard, or list — navigation moves between them.
2. **Notifications are the entry point.** The most valuable mobile moment is
   "an agent needs you" → tap notification → answer in 10 seconds → done.
3. **Read & steer, don't wire.** Monitoring, chatting, answering forms, and
   absent (deep-link "open on desktop" instead).
4. **Reuse the protocol verbatim.** Same `useSocket`, same WS commands, same
   `NormalizedEvent` stream, same Render DSL. The mobile client is a new *view*,
   not a new *backend*.
5. **Respect the medium.** 44px touch targets, bottom-anchored input above the
   keyboard, safe-area insets, pull-to-refresh, swipe-to-switch, no hover-only
   affordances.

---

## 3. Information architecture

A bottom tab bar with four destinations + a contextual session switcher:

```
┌─────────────────────────────────────┐
│  (current screen content)            │
│                                      │
│                                      │
├──────────────────────────────────────┤
│  🏠 Home   ⚡ Activity   💬 Chat   📊 Board │
└─────────────────────────────────────┘
```

- **Home** — project picker + per-project live summary (minions running, cost
  today, pending decisions).
- **Activity** — the "Situation Room": a unified reverse-chronological feed of
  what every session is doing right now. The default landing screen once inside
  a project.
- **Chat** — the active conversation thread (leader or a chosen minion), with a
  swipe/dropdown session switcher at the top.
- **Board** — the leader's Render DSL dashboard, forced to a single column.

A persistent **"needs you" badge** rides on the tab bar whenever any session has
an open form/question or a pending approval.

---

## 4. Screen-by-screen

### 4.1 Home / project list
- Recent projects (from `~/.minions/recent-projects.json` via existing API).
- Each row shows live badges: `▶ 3 running · $0.42 · ⚠ 1 needs you`.
- Tap → enter project, land on Activity.

### 4.2 Activity ("Situation Room") — the heart of mobile
A vertical feed of session cards, sorted by most-recent-activity:

```
┌──────────────────────────────────────┐
│ 🟢 Leader · "Mobile concept"          │
│ Spawning minions… · 4 turns · $0.31   │
│ "Now mapping the canvas UI…"          │
├──────────────────────────────────────┤
│ 🔵 Minion · Map server architecture   │
│ ▓▓▓▓▓░░ running · 2m                   │
├──────────────────────────────────────┤
│ ⚠️  Leader needs a decision           │
│ "Pick auth strategy" · [Answer →]     │
├──────────────────────────────────────┤
│ ✅ Minion · Map canvas UI · done      │
└──────────────────────────────────────┘
```
- Each card is a live subscriber to its `session:<key>` topic — status, progress,
  cost, and the latest text line update in place.
- Cards needing input float to the top with an inline CTA.
- Tap a card → that session's Chat (or the inline form for a decision card).

### 4.3 Chat (session detail)
- Chat is already mobile-native; this is the cleanest reuse.
- Reuses `normalizedToDisplayMessages` → bubbles: assistant text, collapsible
  thinking, tool calls (collapsed by default to save height), results.
- Streaming via existing `text_delta` / `blockIndex` handling.
- Top bar: session name + a switcher (swipe left/right, or tap to pick another
  session in the project).
- Bottom: input bar pinned above the keyboard; send / stop button; attach image.
- Sub-agent (minion) events stay filtered out of the leader thread (existing
  `parentId` filter), but the leader's task-plan minions are reachable via the
  switcher.

### 4.4 Board (dashboard)
- Render DSL → single responsive column (`columns: 1`).
- The DSL already carries everything needed: `metric`, `progress`, `status`,
  `table`, `chart`, `form`, `section`, `tabs`, etc. Tables get horizontal scroll;
  `section`/`tabs` stay as accordions/segmented controls.
- **Forms are the standout**: an agent-rendered `form` becomes a native-feeling
  mobile form; submit sends the existing form-submission command.

### 4.5 Decisions & approvals (the "needs you" inbox)
- A focused sheet listing every open ask across the project:
  - Leader/agent **questions** (rendered forms / AskUserQuestion-style prompts).
  - **Worktree approvals**: minion finished, changes await approval.
- For approvals on mobile: show the **summary + file list + stats** and offer
  `Approve` / `Discard` / `Open diff on desktop`. Full line-by-line diff review
  is deferred to desktop (diffs are genuinely bad on a phone); a compact
  per-file diff viewer is a stretch goal.

### 4.6 Canvas — read-only minimap (optional, later)
- Not an editor. A pinch-zoom overview rendering nodes as labeled dots/cards and
  edges as lines, purely for orientation. Tap a node → its detail sheet.
- Justifies keeping the spatial mental model without porting the editor.

---

## 5. Interaction & gesture model

| Gesture | Action |
|---|---|
| Tap card | Open session / decision |
| Swipe L/R in Chat | Switch session |
| Pull down | Refresh / re-sync (`sync_session`) |
| Long-press card | Quick actions: stop, focus, mark read |
| Swipe card away | Dismiss from feed (not from project) |
| Pinch (minimap) | Zoom overview |

No drag-to-wire, no marquee select, no port snapping — all desktop-only.

---

## 6. Notifications — the spine

Push notifications turn "agents running in the background" into a genuinely
hands-off experience:

- **Needs input** — leader rendered a form / asked a question. (highest priority)
- **Minion finished** — done, with one-line result + Approve CTA.
- **Failure / error** — session errored, rate-limited, or stalled.
- **Budget** — cost crossed a user-set threshold.

Tapping a notification deep-links straight to the relevant Chat, form, or
approval sheet. Web Push (PWA) covers iOS 16.4+ and Android; a thin server-side
notifier maps existing bus events (`agent_task_update`, `done`,
`permission_denial`, `minion_completed`, render `form` events) to pushes.

---

## 7. Scope: mobile vs. defer-to-desktop

| Capability | Mobile | Notes |
|---|---|---|
| Monitor sessions (feed) | ✅ Core | new view over existing topics |
| Chat with leader / minion | ✅ Core | reuse streaming + messages |
| Answer agent forms / questions | ✅ Core | Render DSL `form` already exists |
| View dashboards | ✅ Core | force single column |
| Stop / abort a session | ✅ | existing command |
| Start a leader from a preset | ✅ | preset picker, no wiring |
| Approve / discard worktree | ✅ summary | full diff → desktop |
| Push notifications | ✅ Differentiator | new server notifier |
| Read-only canvas minimap | 🟡 Later | orientation only |
| Wire edges / build context graphs | ❌ Desktop | precision authoring |
| Line-by-line diff review | ❌ Desktop | poor on phone |

---

## 8. Technical approach

**Recommendation: a responsive PWA layer over the existing React app**, not a
separate native app. Rationale:

- Transport is already mobile-friendly: `useSocket` (token via `?token=`, backoff
  reconnect), JSON `WsEnvelope`s filtered by topic client-side, server-side
  SQLite persistence + `sync_session` resume. A phone connects exactly like a
  desktop tab (same per-server token, ideal over Tailscale).
- The Render DSL and message components are React — reusable in a web view.
- PWA gives installability + Web Push without an app-store pipeline.
- A native Expo/React Native app is a *possible* phase 3 if native polish or
  background push reliability demands it, but it duplicates UI for little day-one
  gain.

### Shell strategy
- Add a viewport breakpoint at the `ProjectView` shell (e.g. `< 768px`).
- Below it, mount `<MobileShell>` (tabs + feed + chat + board) **instead of**
  `<Canvas>`; above it, the canvas is unchanged.
- `MobileShell` reuses: `useSocket`, `streaming.ts`, `sdk-messages.ts`, session
  sync, Render DSL renderers (with `columns: 1`), and the *content* of node
  components (chat body, dashboard body) extracted from their canvas card chrome.
- Keep desktop untouched — this is additive, gated by breakpoint.

### Refactors this implies (and that benefit desktop too)
- Decouple node **content** from canvas **card chrome** so chat/dashboard/board
  bodies render in a full-screen sheet as easily as in a positioned node.
- A small server-side **notifier** that subscribes to the bus and fans out Web
  Push (respects the existing no-account / single-token model; subscriptions
  stored per project sidecar).
- Viewport/meta: `viewport-fit=cover` + safe-area-inset padding.

### Auth / multi-device caveat
There are no user accounts today — one random token per server instance. A phone
fetches the same `/api/auth/token` and connects. This is fine on a private
Tailnet/LAN but means **no per-user isolation**; if mobile drives broader remote
access, a real auth story (even a simple device-pairing flow) becomes the
prerequisite. Flag this explicitly before shipping beyond personal use.

---

## 9. Phased rollout

1. **Phase 0 — Read-only companion.** Breakpoint shell, Activity feed, Chat
   (view + send), Board (single column). No notifications yet. Proves the reuse.
2. **Phase 1 — Steer & decide.** Inline forms/questions, stop/abort, start from
   preset, worktree approve/discard (summary).
3. **Phase 2 — Notifications.** Server notifier + Web Push + deep links. This is
   where mobile becomes genuinely useful unattended.
4. **Phase 3 — Polish & optional native.** Read-only minimap, gesture refinement,
   and a device-pairing auth flow; evaluate native Expo wrapper if needed.

---

## 10. Open questions

- Do we want a **read-only minimap** at all, or is the feed enough orientation?
- Is **worktree approval from mobile** acceptable without full diff review, or
  must it always bounce to desktop?
- How far does remote access go — personal Tailnet only, or do we need real
  **auth** before mobile ships? (Likely a hard prerequisite for anything public.)
- PWA-first vs. native-first given iOS Web Push limitations in practice.
