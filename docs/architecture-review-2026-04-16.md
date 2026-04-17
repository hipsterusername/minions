# Architecture Review — Minions Canvas

**Date:** 2026-04-16
**Scope:** refactor-existing
**Focus:** Identify design flaws that will block the vision — Leader/Agent Node workflows, linked chats across multiple views, tool-composed UI (dashboards), and a canvas as a context-management surface.

---

## Executive Summary

The core model is right: a graph of typed nodes that exchange messages, with agent sessions as first-class nodes and MCP tools as the bridge between agent intent and UI. Three abstractions are doing most of the work: **the node registry** (`node-registry.ts`), **the port/protocol contract system** (`graph.ts`), and **the render DSL** (`render-dsl.ts`). These are keepers.

What's holding the project back is a set of accidental couplings that accumulated before the vision crystallized:

1. **Routing is faked.** The graph defines edges and protocols, but actual data flow is broadcast-to-all WS with string `sessionKey` filtering in every consumer. The visual edges for task-assignment/status/result exist only as `hidden: true` decoration — they don't route. This is the single biggest blocker for "linked chats across views."
2. **The server is a 1966-line monolith** (`server/index.ts`) with no abstraction for "a session" as a pluggable type. Leader, Minion, and Default branch inside `runSession()`. Any new agent role forces edits across this god-file plus `Canvas.tsx`.
3. **Session hosting is duplicated three times** — `LeaderNode` (3553 lines), `ClaudeSessionNode` (1571), and `MinionNode` (1109) each reimplement WS subscription, message rendering, status UI, and streaming. A `SessionHost<TData>` primitive would reclaim ~3k lines.

Below: capability map, flaw catalog, target architecture, and a 4-phase refactor plan.

---

## 1. Capability Abstraction Map

| Capability | Location | Quality | Notes |
|---|---|---|---|
| Node registry | `src/node-registry.ts` (19 lines) | ✅ Clean | Pure map, `registerNodeType` side-effect. Good. |
| Port/protocol contracts | `src/graph.ts` (271 lines) | ✅ Clean | Formal port model with `canConnect` validation. |
| Graph reducer / edge CRUD | `src/graph-runtime.ts` (153 lines) | ⚠️ Underused | `dispatchMessage` exists but only context flows through it; task-assignment/status/result bypass it. |
| Canvas history (undo/redo) | `src/canvas-state.ts` (126 lines) | ✅ Clean | Pure reducer + history hook. |
| Render DSL (agent→UI) | `src/render-dsl.ts` (185 lines) | ✅ Clean | Tight, token-efficient, patch-friendly. Model component. |
| SDK→Display conversion | `src/sdk-messages.ts` (177 lines) | ✅ Clean | Single shared converter; deduplicated between Leader/Minion. |
| WebSocket transport | `src/use-socket.ts` (757 lines) | ⚠️ Firehose | Singleton + broadcast-to-all; filtering in every consumer. ~23 `SdkMessage` types + 19 server-message types. No topics. |
| Session lifecycle (server) | `server/index.ts` (1966 lines) | ❌ Monolith | HTTP + WS + lifecycle + MCP + worktree + merge + approval + resume + cleanup all in one file; 40 WS command types via string switch. |
| Session hosting (client) | `LeaderNode.tsx` 3553 + `ClaudeSessionNode.tsx` 1571 + `MinionNode.tsx` 1109 | ❌ Duplicated | Same subscription, rendering, streaming, status patterns repeated. |
| Agent role | `server/index.ts:191` (`role: "leader" \| "minion" \| "default"`) | ❌ Stringly-typed | Used as a branch discriminator in `runSession()`. Not polymorphic. |
| MCP tool factories | `server/task-tools.ts`, `render-tools.ts`, `minion-tools.ts` | ⚠️ Inconsistent | Each factory broadcasts its own ad-hoc WS events; no shared envelope. |
| System prompts | `src/prompts/*.ts` | ⚠️ Leaky | 140-line markdown blobs. Server imports `../src/prompts/minion-system.ts` — cross-tree boundary violation. |
| Worktree lifecycle | `server/worktree.ts` (604 lines) | ✅ Self-contained | Cohesive module, good. |
| Persistence | `server/db.ts` (47) + `server/project-store.ts` (179) | ⚠️ Incomplete | Stores projects + nodes + kanban + skills. Does **not** persist running sessions, task state, render state, message history, or approval state. |
| Canvas editor | `src/Canvas.tsx` (3125 lines) | ❌ Omnibus | 12+ distinct concerns in one file. Hardcoded `type === "leader"/"minion"/"context-group"/…` in multiple places. |

---

## 2. Design Flaw Catalog

Ranked by impact on the vision. Each flaw includes: what, where, why it blocks the future, suggested direction.

### F1 — Ornamental graph, string-based routing ⚠️⚠️⚠️

**What.** The graph contract system (`src/graph.ts`) defines ports and protocols for `task-assignment`, `task-status`, `task-result`, `context`. But only `context` actually flows through edges (consumed by `getContextForNode` in `src/Canvas.tsx`). The other three are declared with `hidden: true` (`src/graph.ts:95, 103, 111`) — they exist visually but carry no data. Real Leader↔Minion wiring is done by the server broadcasting `minion_spawned`, `task_plan_update`, `minion_status`, `minion_completed` to all clients, and every consumer filtering with `serverMsg.leaderSessionKey === mySessionKey`.

**Where.**
- `src/graph.ts:88-122` declares leader ports as hidden.
- `src/graph-runtime.ts:104-115` defines `dispatchMessage` — used only for context flow.
- `server/task-tools.ts:273-284` (assign_task) broadcasts `minion_spawned` to all WS clients directly.
- `src/Canvas.tsx:2215` filters by sessionKey on receipt.

**Why it blocks.** "Linked chats across multiple views" requires that a Leader's conversation show in an inspector panel, a kanban card detail, a mobile companion view — any surface that mounts for this session. Today each surface must know the shape of every broadcast type and re-implement the same filtering. A graph-routed model with topic subscriptions lets views declare "I want the Leader feed for session X" once; new views inherit.

**Direction.** Make the graph the real routing layer. The server emits `EdgeMessage` payloads into a typed, addressed bus (`{topic, sessionKey, protocol, payload}`); the client's `graph-runtime` subscribes views by (sessionKey, protocol), not by scanning a firehose. Un-hide Leader ports — the edge visualization and the data flow should be the same thing.

---

### F2 — `server/index.ts` is a god-object (1966 lines) ⚠️⚠️⚠️

**What.** One file holds: Express setup, WS upgrade, auth, 40+ WS command dispatchers via string switch, `runSession()` (the factory for every agent), MCP tool wiring per role, worktree create/merge/discard/force-merge/theirs-merge, approval flow, wait-and-continue scheduling, event-buffer management, session resume, stale-worktree cleanup. A `Session` interface (`server/index.ts:173-199`) has 20+ fields because it must hold everyone's state.

**Where.**
- `server/index.ts:271-415` — `runSession()` with role-branching.
- `server/index.ts:796-1891` — `handleCommand()` — a 1000-line switch.
- `server/index.ts:1252-1599` — merge/approval/worktree commands.

**Why it blocks.** Adding a new agent role (Reviewer, Planner, Critic, Context-Explorer, future Leader-of-Leaders) currently means: add a `role` branch in `runSession()`, add MCP tool selection logic, add a handful of WS event types, touch sanitization in `App.tsx`, add cases in `Canvas.tsx`. The god-file is the chokepoint.

**Direction.** Introduce a **SessionType** (server-side) — a registry mirroring the client-side node registry. Each agent role is a pluggable bundle: `{systemPromptBuilder, mcpServers, allowedTools, onInit, onResult}`. `runSession()` becomes a ~80-line dispatcher that looks up the type and calls its lifecycle hooks.

---

### F3 — Three nodes duplicate session hosting ⚠️⚠️⚠️

**What.** `LeaderNode.tsx` (3553), `MinionNode.tsx` (1109), and `ClaudeSessionNode.tsx` (1571) each independently implement: WS subscription with sessionKey filtering, `sdkToDisplayMessages` wrapping, message grouping, streaming buffer, tool-call rendering, status banners, scroll-to-bottom, model/permission selectors. Observed overlap is ~40% between LeaderNode and ClaudeSessionNode (exploration agent summary).

**Where.**
- `src/nodes/LeaderNode.tsx:2392-2729` — subscription block.
- `src/nodes/ClaudeSessionNode.tsx:900-1050` — near-identical subscription block.
- `src/nodes/MinionNode.tsx:175-440` — same pattern with minion-status extensions.

**Why it blocks.** "Linked chats across views" and "context-management canvas" both want to show an agent's conversation in multiple places with different affordances (compact, expanded, side-by-side diff view). With three separate chat implementations, we'd have to pick one to fork or build a fourth.

**Direction.** Extract a `<SessionHost sessionKey={k}>` primitive with slots for header, footer, and agent-specific side-panels. LeaderNode becomes a thin wrapper that passes `<TaskBoard/>` and `<WorktreePanel/>` as slots. A new "inspector view" can mount the same `<SessionHost>` with a different layout.

---

### F4 — System prompts cross the server/client boundary ⚠️⚠️

**What.** `server/index.ts:12` imports `MINION_SYSTEM_PROMPT` from `../src/prompts/minion-system.ts`. The client imports the same constants from 4 places (`LeaderNode`, `MinionNode`, `KanbanBoard`, `App`, `CardCreationChat`). Prompts are 140-line markdown blobs with hardcoded tool names, workflow steps, approval rules, and dashboard DSL docs inlined.

**Where.**
- `server/index.ts:12` — boundary crossing import.
- `src/prompts/leader-system.ts:1-144` — single `LEADER_SYSTEM_PROMPT` constant, no parameterization.
- `src/prompts/minion-system.ts:1-25` — same.

**Why it blocks.** (a) Prompts can't be edited per-project/per-skill without rebuilding both trees. (b) New components in the render DSL don't auto-appear in the prompt — the prompt and the Zod schema drift silently. (c) Agent roles are defined by string constants, not first-class objects. The vision's "Leader/Agent Node driven workflow" implies many agent kinds; today each would be another boundary-crossing constant.

**Direction.** Move prompts into `server/agents/<role>.ts` as prompt builders that take runtime context (available tools, worktree info, existing task state). Generate the tool-docs section of the prompt programmatically from the Zod schemas so the prompt and the implementation can't drift. The client doesn't need the raw prompt — it needs a `getDisplayPrompt(role)` REST/WS call if it wants a preview.

---

### F5 — WS is a broadcast firehose ⚠️⚠️

**What.** `src/use-socket.ts:707` iterates `listenersRef.current` and sends every message to every listener. There's no per-subscription topic filter and no per-session channel. `KNOWN_SERVER_MESSAGE_TYPES` (19 entries, lines 612-642) is maintained by hand; every new server event type must be added there. On the server side, 15 `broadcast(wss, ...)` call sites across 4 files each send messages to all clients.

**Where.**
- `src/use-socket.ts:611-649, 707-709`.
- `server/task-tools.ts:77-84`, `server/render-tools.ts:26-33`, `server/minion-tools.ts:14-21`, plus many in `server/index.ts`.

**Why it blocks.** (a) Multi-window / multi-view = quadratic traffic. (b) Two instances of the canvas for the same project see each other's updates (maybe intentional, maybe not — never declared). (c) New views must register their own filter logic.

**Direction.** Wrap outbound messages in a typed envelope: `{topic: "session:${key}" | "project:${id}" | "global", event: …}`. Client subscribes by topic. The `dispatchMessage` function in graph-runtime becomes the natural subscribe API: `subscribeToEdge(sessionKey, protocol)`.

---

### F6 — No agent-role abstraction on the server ⚠️⚠️

**What.** `role: "leader" | "minion" | "default"` (`server/index.ts:191`). Branches in `runSession()`:
- Which MCP servers to create (task, render, minion-status).
- Whether to create a worktree (leader only, `server/index.ts:415-468`).
- Which system prompt to use.
- Whether to derive a task name.

**Where.** `server/index.ts:404, 415, 496-516, 586-659`.

**Why it blocks.** This is the structural version of F2 and F4. Without a role abstraction, you can't: plug in a Card-Creation agent as a first-class session type, let users define custom agent roles from a skill, or support a "context-explorer" session beyond the current one-off.

**Direction.** `interface AgentType { id; buildSystemPrompt(ctx); mcpServers(ctx); allowedTools; wantsWorktree; sanitizeData(data) }` + registry. Server and client both consult it.

---

### F7 — 61 hardcoded node-type string checks on the client ⚠️

**What.** Grep for `type === "leader"|"minion"|"context-group"|"markdown"|"claude-session"` returns 61 hits across 6 files (`src/Canvas.tsx:33`, `src/App.tsx:8`, `src/CanvasNode.tsx:4`, `src/KanbanBoard.tsx:5`, `src/ProjectPanel.tsx:9`, `src/use-canvas-keyboard.ts:2`). Canvas special-cases:
- Leader-drag-bundles-its-minions (`src/Canvas.tsx:1494-1502`).
- Context-group reflow on resize (`src/Canvas.tsx:1504-1514`).
- Render-node positioning relative to leader (`src/Canvas.tsx:2426-2440`).
- Droppable type whitelist (`src/Canvas.tsx:525`).

**Why it blocks.** These are real compositional relationships — a leader "owns" its minions and render panel — but they're expressed as string matches, not as declarations in the node-type definition. The registry knows `type`, `label`, `defaultSize`, `render`; it doesn't know "this node type is a parent of these children" or "this node extracts context."

**Direction.** Extend `NodeTypeDefinition`:
```ts
interface NodeTypeDefinition<T = unknown> {
  …existing…;
  /** Child node types that move with this node and lay out relative to it. */
  ownsChildrenOfType?: string[];
  /** When true, this node extracts context via getContextForNode. */
  providesContext?: (data: T) => ContextItem | null;
  /** When this node is dragged/resized, layout hint for the canvas. */
  layoutPolicy?: "fixed" | "reflow-children" | "snap-to-parent";
  /** Sanitize persisted data on load (status reset, etc). */
  sanitizeOnLoad?: (data: T) => T;
}
```
Canvas.tsx consults the registry; special-cases disappear.

---

### F8 — Canvas.tsx is an omnibus editor (3125 lines) ⚠️

**What.** A dozen concerns live here: pan/zoom, selection (click/shift/marquee), drag (single/group), edge drawing, context menu, keyboard shortcuts, file drop, auto-layout, socket subscription for `minion_spawned`/`task_plan_update`/`render_update`, node-type defaults, context-group reflow, zoom-to-fit, focus-on-node.

**Where.** Responsibility breakdown per the exploration agent's map (see `src/Canvas.tsx:429-2780`).

**Why it blocks.** Hard to test, hard to extend. The socket-subscription block (lines 2186-2447) is really a controller that creates minion nodes, render nodes, and wires edges in response to server events — it should live outside the visual canvas editor.

**Direction.** Split into:
- `Canvas.tsx` — pure viewport + selection + drag (≤600 lines).
- `useCanvasGraphController.ts` — subscribes to WS, mutates the graph/canvas reducers.
- `useCanvasLayout.ts` — owns auto-layout and children-reflow policies from the registry.
- Move keyboard/file-drop hooks (already factored) to consume a `CanvasController` interface.

---

### F9 — No persistence for running session state ⚠️

**What.** `Map<sessionKey, Session>` in `server/index.ts:271`. Server restart = all sessions forgotten. SQLite stores projects, nodes, kanban, skills — not task state, not render state, not conversation history (messages live in `CanvasNode.data`, persisted by the client autosave, but server-side in-flight tool state is ephemeral).

**Why it blocks.** "Context management canvas" implies the canvas persists across sessions: come back next week, your leader's task plan, render dashboard, and chat log are still there. Today a restart means "disconnected" status and lost task state.

**Direction.** Persist: `taskState` (per leader), `renderState` (per leader), approval state, wait-timer state. These are already structured (`TaskManagerState` in `server/task-tools.ts:67`, `RenderState` in `render-tools.ts:17`). Append-only event log per session gives time-travel and derived views for free.

---

### F10 — No session cleanup on WS disconnect ⚠️

**What.** `server/index.ts:1926-1928` logs the close; nothing else. Sessions remain in the map indefinitely. Wait-timers fire. Abort controllers stay open.

**Why it blocks.** Long-lived server + iterative development = slow memory growth. Low severity today, relevant at scale.

**Direction.** Heartbeat + idle TTL per session, with explicit "reconnect within N minutes" grace window tied to resumable `sessionId`.

---

### F11 — Context port state-machine is a one-off special case ⚠️

**What.** `canAcceptContextConnection` (`src/graph.ts:262-271`) hardcodes: "only leader + context-in port, locked after sessionKey is set." Instead of a general port-lifecycle model.

**Why it blocks.** Next port with similar semantics (e.g., a Reviewer node whose task-in port locks after review starts) will be another special case. At 3+, we'll regret not generalizing.

**Direction.** `PortDefinition.lifecycle?: (targetData) => "open" | "locked" | "closed"` — the contract declares its own gate.

---

### F12 — Render DSL is duplicated between server and client ⚠️

**What.** Server (`server/render-tools.ts:37-44`) defines a Zod schema with `.passthrough()`. Client (`src/render-dsl.ts:14-81`) defines the full `RenderComponent` discriminated union. Same concept, two sources of truth. A new component type means editing both.

**Why it blocks.** The render DSL is central to "tools that compose UI" — it's going to grow. Schema drift between client and server will cause silent runtime bugs.

**Direction.** Shared schema file consumed by both. Either ESM-shared (`shared/render-dsl.ts`) or a generated types file. Server uses the same Zod, client uses `z.infer`.

---

### F13 — Leader prompt duplicates runtime behavior in prose ⚠️

**What.** `src/prompts/leader-system.ts` includes a table of all render DSL component types (lines 79-87), a table of MCP tools (lines 11-17), and a worktree-approval workflow (lines 101-127). All of these exist as code too.

**Why it blocks.** Drift. Adding a new component/tool/rule requires updating the prompt or the agent silently loses the capability. High burden on whoever edits the DSL.

**Direction.** Split the prompt into (a) a behavioral core (short, stable) and (b) a capability manifest auto-generated from tool Zod schemas + render DSL schema at session start. Composition, not concatenation.

---

### F14 — `role` and `type` are two names for the same concept ⚠️

**What.** Client knows `node.type: "leader" | "minion" | ...`. Server knows `session.role: "leader" | "minion" | "default"`. They must agree but the mapping is implicit (client sends `role` in create_session; server has no node-type awareness).

**Why it blocks.** Adding a new agent node = editing both vocabularies and hoping they stay in sync.

**Direction.** Unify on `agentType`. Client's `NodeTypeDefinition` declares an optional `agentType` field; server's agent-type registry keys by the same string. Single source of truth.

---

### F15 — `ClaudeSessionNode` looks like a legacy node ⚠️

**What.** Generic Claude session with 1571 lines that's largely superseded by Leader. The context.md calls it "older direct-use node." It has no MCP tools, no task board, no worktree isolation, but replicates the chat infrastructure.

**Why it blocks.** Three-way overlap (F3) is really two-way + a legacy holdover. Guidance in the global CLAUDE.md — *"Replace, don't deprecate"* — says this should be removed once Leader covers its use-cases, or collapsed into `SessionHost` from F3.

**Direction.** Audit. Either remove, or refactor so Leader is `SessionHost + LeaderControls` and Claude-session is `SessionHost` with a minimal config.

---

## 3. Target Architecture Sketch

A principled version of what's already emerging:

```
┌─────────────────────────────────────────────────────────────┐
│  Client                                                     │
│                                                             │
│  App → ProjectView                                          │
│    ├── Canvas (viewport + selection + drag only)            │
│    │     └── CanvasNode → registry.render(type, data)       │
│    ├── useCanvasGraphController (WS → graph/node mutations) │
│    └── Views that mount SessionHost:                        │
│          LeaderNode = SessionHost + <LeaderControls/>       │
│          MinionNode = SessionHost + <MinionStatus/>         │
│          InspectorPanel = SessionHost (future)              │
│          MobileView = SessionHost (future)                  │
│                                                             │
│  graph-runtime.subscribe(sessionKey, protocol) ← the bus    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Shared (new) — zod schemas for WS envelope + render DSL    │
├─────────────────────────────────────────────────────────────┤
│  Server                                                     │
│                                                             │
│  index.ts (thin): HTTP, WS upgrade, auth, command router    │
│    └─ dispatch(command) → handlers/<command>.ts             │
│                                                             │
│  agents/ (new):                                             │
│    registry.ts  → AgentType[]                               │
│    leader.ts    → {prompt, tools, wantsWorktree, …}         │
│    minion.ts                                                │
│    reviewer.ts  (future, plug-in)                           │
│                                                             │
│  bus.ts (new): typed envelope broadcast, topic subscribe    │
│    └─ sessions use bus.emit({topic, protocol, payload})     │
│                                                             │
│  sessions/                                                  │
│    runSession.ts  (thin, consults agents registry)          │
│    store.ts       (persist taskState/renderState/approval)  │
│                                                             │
│  worktree.ts      (unchanged — cohesive module)             │
│  mcp/ (per-role tool factories, emit via bus)               │
│  project-store.ts (extended to persist session state)       │
└─────────────────────────────────────────────────────────────┘
```

**Principles.**

1. **The graph is the bus.** Edge protocols are the type system for messages; `dispatchMessage` is the routing primitive; visual edges match data flow.
2. **One agent-type registry, two consumers.** Client registry for rendering, server registry for behavior; both keyed by the same id.
3. **SessionHost is reusable UI.** One chat infra, many views.
4. **Server files are ≤400 lines.** `index.ts` becomes a dispatcher; each command, each agent, each tool is its own small file.
5. **Session state is persistable.** Task plan, render state, approval, and conversation live in SQLite with an append-only event log per session.
6. **Prompts compose from schemas.** No hand-written tool docs in the prompt; generated from Zod + render DSL.

---

## 4. Phased Refactor Plan

Ordered so each phase delivers value and creates the scaffolding for the next. No "big bang."

### Phase 0 — Guardrails (1–2 days)

Deliverables:
- Add `ESLint` rule (or ripgrep CI check) banning new `broadcast(wss, ...)` call sites outside the new `server/bus.ts` (added in Phase 2).
- Add CI check: `server/*.ts` files ≤400 lines.
- Add architecture fitness test: no import from `server/` into `src/` or vice versa (currently violated by `server/index.ts:12`).
- Document target module boundaries in `docs/architecture.md`.

Risk: Very low. Catches regressions while we refactor.

---

### Phase 1 — SessionHost primitive (1 week)

Deliverables:
- Extract `src/components/SessionHost.tsx` from the overlap of `LeaderNode`/`ClaudeSessionNode`/`MinionNode`. Props: `sessionKey`, slots for header, footer, side panel. Owns: subscription, streaming, message grouping, tool rendering, scroll.
- Rewrite `ClaudeSessionNode` as `<SessionHost … />` with a minimal footer.
- Rewrite `LeaderNode` as `<SessionHost><TaskBoard/><WorktreePanel/><ApprovalBar/></SessionHost>`.
- Rewrite `MinionNode` as `<SessionHost><MinionStatus/></SessionHost>`.

Target reduction: ~3000 lines across the three node files.

Risk: Medium. The nodes hold a lot of state. Mitigation: write a snapshot-style test harness that replays a recorded WS stream and asserts on the rendered message feed before and after.

Open question: does the legacy `ClaudeSessionNode` have use cases the Leader can't cover? If not, remove it (global rule: "replace, don't deprecate").

---

### Phase 2 — Typed bus + shared schemas (1 week)

Deliverables:
- `shared/ws-envelope.ts` — zod schema for `{topic, protocol, payload}`.
- `shared/render-dsl.ts` — deduplicate `server/render-tools.ts` + `src/render-dsl.ts`.
- `server/bus.ts` — replaces direct `broadcast(wss, ...)`. Factory: `getBus(wss)` → `{emit(envelope), emitToSession(key, event)}`.
- `src/use-socket.ts` gains `subscribe(topic, handler)` that pre-filters. Keep the firehose as escape hatch initially.
- Migrate all 15 broadcast sites to the bus. Prune the client's `KNOWN_SERVER_MESSAGE_TYPES` set — it's subsumed by envelope validation.

Value: "Linked chats across views" is now one subscribe call.

Risk: Low if done incrementally; each broadcast migration is isolated.

Open question: does a second client instance on the same project want isolated traffic, or shared? Need product decision — make it a per-topic policy.

---

### Phase 3 — Agent type registry (1 week)

Deliverables:
- `server/agents/types.ts` — `AgentType` interface.
- `server/agents/{leader,minion,default}.ts` — move role-specific logic out of `runSession()`.
- `server/agents/registry.ts` — `registerAgentType` / `getAgentType`.
- `src/types.ts::NodeTypeDefinition` gains optional `agentType`.
- `runSession()` shrinks to a ~60-line dispatcher.
- Move `src/prompts/*` → `server/agents/<role>/prompt.ts`. Client never imports them again.
- Prompt composition: `buildSystemPrompt(agentType, ctx)` generates the tools/DSL sections from Zod schemas.

Value: adding a "Reviewer" or "Context-Explorer" agent is ~50 lines of new code, no god-file edit.

Risk: Medium. Touches session startup, the critical path. Mitigation: feature-flag per agent type; leader/minion keep working while new agents are added.

---

### Phase 4 — Graph-as-bus + persisted sessions (1–2 weeks)

Deliverables:
- Un-hide leader ports. Visual edges now carry task-assignment/status/result messages. `graph-runtime.dispatchMessage` is the real routing primitive; the server bus emits into edges rather than broadcasting by sessionKey.
- Generalize `canAcceptContextConnection` → `PortDefinition.lifecycle`.
- Node type declarative extensions: `ownsChildrenOfType`, `providesContext`, `layoutPolicy`, `sanitizeOnLoad`.
- Canvas.tsx purge of hardcoded type checks — consult the registry.
- Persist `taskState`, `renderState`, `approvalState`, message log per session in SQLite. Resume after server restart returns a running-like state.
- Event log per session (append-only): every tool call, every status change. Enables time-travel and multi-view derivation.

Value: "Context management canvas" becomes real. Views can derive from the event log. Sessions survive restarts.

Risk: High — this is the vision. Mitigation: ship Phase 4 in 4 sub-PRs (graph routing, port lifecycle, registry extensions, persistence) so each is independently reversible.

---

### Phase 5 — Canvas decomposition (1 week, after Phase 4)

Deliverables:
- Split Canvas.tsx into Canvas + controllers (as in F8).
- Split server/index.ts into `index.ts` + `handlers/<command>.ts` (as in F2).
- Remove `ClaudeSessionNode` if not replaced by SessionHost consumers.

Value: files ≤400 lines, new features don't touch the god-files.

Risk: Low (tests from Phase 1 already cover SessionHost).

---

## 5. Risks & Open Questions

- **Q: Should a Leader's worktree persist across restarts?** The branch is on disk, so yes — but the in-memory `Session.worktree` isn't persisted. Need to decide whether re-attaching to an abandoned worktree is automatic or user-confirmed.
- **Q: When two Leader views open the same session, are they peers or does one own it?** Affects envelope topic design.
- **Q: Is `ClaudeSessionNode` still needed?** Audit first week of Phase 1.
- **Risk: Minion-system prompt lives in `src/prompts/minion-system.ts` and is imported by the server.** The import path works via `tsx` but is cross-tree. Phase 3 moves it, but until then any restructure of `src/` risks breaking server startup. Add a build check.
- **Risk: The WS firehose has hidden consumers.** Before pruning `KNOWN_SERVER_MESSAGE_TYPES` in Phase 2, grep for every entry to ensure every handler is migrated.
- **Risk: Undo/redo interacts with server-driven mutations.** `useCanvasHistory` only tracks user actions. If server adds a minion node via `minion_spawned`, it's not in the history. Phase 4's graph-routed model needs to decide whether server-side mutations are undoable.
- **Open: Rate limit on render updates.** A runaway agent can spam `render_patch`. Not addressed today. Add a per-session broadcast rate limit in Phase 2's bus.
- **Open: Auth on the WS is a bootstrap token.** Fine for localhost-only; note this for the day it moves off-device.

---

## 6. Summary Table

| Phase | Duration | Lines removed (est.) | Unlocks |
|---|---|---|---|
| 0 — Guardrails | 1–2 days | 0 | CI safety net |
| 1 — SessionHost | 1 week | ~3000 | Linked chats across views |
| 2 — Typed bus + shared schemas | 1 week | ~200 | Topic routing; multi-view without firehose |
| 3 — Agent type registry | 1 week | ~300 (from server/index.ts) | Pluggable agents; prompts composed from schemas |
| 4 — Graph-as-bus + persistence | 1–2 weeks | ~400 | Context-management canvas; restart-safe sessions |
| 5 — Canvas / server decomposition | 1 week | ~1500 reorganized | Maintainable surface for future work |

Total: ~5 weeks to a structurally different codebase, delivered in incremental, reversible steps. No "rewrite" required.
