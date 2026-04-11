# Minions — Project Context

> Generated 2026-03-31. Read time: ~5 minutes.

---

## 1. What Is This?

**Minions** is an infinite-canvas web UI for orchestrating multiple Claude Code AI agent sessions. You open a project directory, place nodes on a canvas, and connect them with typed edges. The key nodes are:

- **Leader** — an orchestrating Claude session that decomposes work, plans tasks, and delegates to Minions.
- **Minion** — a worker Claude session that receives task assignments, executes them, and reports progress/results back.
- **ClaudeSession** — a generic Claude session node (no orchestration role).
- **MarkdownNode / FileViewerNode** — context-providing nodes you can wire into a Leader.
- **NoteNode** — sticky note.

A **Kanban board** view sits alongside the canvas as an alternate way to create cards and launch Leaders.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19.2, Vite 8, TypeScript 5.9 (strict) |
| Backend | Node.js, Express 5, `tsx` runtime |
| Realtime | WebSocket (`ws` v8), port **3141** |
| AI SDK | `@anthropic-ai/claude-agent-sdk` v0.2.86 — `query()` returns an async generator of SDK events |
| MCP Tools | `createSdkMcpServer` + `tool` from the SDK (used for Leader task tools & Minion status tools) |
| Persistence | `better-sqlite3` per-project SQLite DB + `~/.claude-canvas/recent-projects.json` |
| Validation | Zod v4 |
| Package manager | pnpm (workspace root) |

---

## 3. Directory Structure

```
/
├── index.html                  # Vite HTML entry
├── package.json
├── vite.config.ts
├── tsconfig.app.json / tsconfig.node.json
│
├── src/                        # Frontend (React)
│   ├── main.tsx                # React entry — mounts <App />
│   ├── App.tsx                 # Root: ProjectList ↔ ProjectView, canvas+graph state
│   ├── Canvas.tsx              # Infinite canvas — panning, zoom, node rendering
│   ├── CanvasNode.tsx          # Node wrapper (drag, select, socket passthrough)
│   ├── canvas-state.ts         # useReducer: ADD_NODE / REMOVE_NODE / MOVE_NODE / RESIZE_NODE …
│   ├── graph.ts                # Port/protocol type definitions, contracts, canConnect()
│   ├── graph-runtime.ts        # graphReducer (edge CRUD), dispatchMessage(), query helpers
│   ├── EdgeRenderer.tsx        # SVG bezier edges with animated dash overlays
│   ├── node-registry.ts        # registerNodeType() / getNodeType() / getAllNodeTypes()
│   ├── types.ts                # Core types: Position, Size, CanvasNode, CanvasAction, NodeRenderProps
│   ├── use-socket.ts           # WebSocket hook: auto-reconnect, ServerMessage union type
│   ├── sdk-messages.ts         # SDK event → DisplayMessage normalisation
│   ├── streaming.ts            # Stream delta extraction helpers
│   ├── api.ts                  # REST fetch helpers (ProjectSummary, ProjectWithNodes, …)
│   ├── use-autosave.ts         # Debounced canvas + graph persistence
│   ├── SessionPanel.tsx        # Collapsible left-panel session list
│   ├── ProjectList.tsx         # Recent projects list
│   ├── ProjectHeader.tsx       # Top bar: canvas / kanban / skills view switcher
│   ├── ProjectPanel.tsx        # Right-side project context panel
│   ├── KanbanBoard.tsx         # Kanban board view
│   ├── kanban-types.ts         # KanbanCard, KanbanColumn, KanbanAction, kanbanReducer
│   ├── use-kanban.ts           # Kanban state hook
│   ├── SkillsBrowser.tsx       # Skill gallery UI
│   ├── SkillEditor.tsx         # Create/edit user skill templates
│   │
│   ├── nodes/                  # Node implementations (each calls registerNodeType)
│   │   ├── LeaderNode.tsx      # Orchestrator session — LeaderData, TaskPlanItem
│   │   ├── MinionNode.tsx      # Worker session — MinionData, MinionTaskState
│   │   ├── ClaudeSessionNode.tsx  # Generic session with collapsible tool groups
│   │   ├── MarkdownNode.tsx    # Editable markdown (context provider)
│   │   └── FileViewerNode.tsx  # Read-only file viewer (context provider)
│   │
│   ├── prompts/
│   │   ├── leader-system.ts    # LEADER_SYSTEM_PROMPT — task planning/delegation instructions
│   │   ├── minion-system.ts    # MINION_SYSTEM_PROMPT — task execution instructions
│   │   └── context-explorer.ts # CONTEXT_EXPLORER_PROMPT
│   │
│   ├── skills/                 # Skill template system
│   │   ├── types.ts            # SkillTemplate, SkillVariable, compileSkills()
│   │   ├── registry.ts         # registerSkill(), getSkill(), getAllSkills()
│   │   ├── user-skills.ts      # LocalStorage-backed user-defined skills
│   │   └── built-in/           # Bundled skill templates (imported for side effects in App.tsx)
│   │
│   └── components/             # Shared UI components
│       ├── StatusBanner.tsx
│       ├── StreamingBubble.tsx
│       ├── SessionToolbar.tsx  # Model picker, permission mode, worktree toggle
│       ├── ResizeHandle.tsx
│       ├── AutoTextarea.tsx
│       ├── SimpleMarkdown.tsx
│       └── CopyButton.tsx
│
└── server/                     # Backend (Node/Express/WS)
    ├── index.ts                # Main: Express + WebSocketServer, Session management
    ├── task-tools.ts           # Leader MCP tools: plan_task, assign_task, complete_task, get_task_status, set_task_name
    ├── minion-tools.ts         # Minion MCP tools: report_step, report_done, report_fail
    ├── worktree.ts             # Git worktree lifecycle: create/merge/discard
    ├── project-store.ts        # SQLite DB per project, recent-projects.json
    ├── db.ts                   # SQLite schema initialisation
    └── routes/
        └── projects.ts         # REST API: /api/projects CRUD, context, settings
```

---

## 4. Key Abstractions

### 4.1 Canvas Nodes (`src/types.ts`)

```ts
interface CanvasNode<T = unknown> {
  id: string; type: string; position: Position; size: Size; data: T;
}
```

`CanvasAction` drives a `useReducer` in `canvas-state.ts` (`ADD_NODE`, `REMOVE_NODE`, `MOVE_NODE`, `RESIZE_NODE`, `UPDATE_NODE_DATA`, `SET_NODES`, `MOVE_GROUP`).

### 4.2 Node Registration Pattern (`src/node-registry.ts`)

Each node file calls `registerNodeType({ type, label, defaultSize, render, userCreatable?, autoHeight? })` as a module side effect. `App.tsx` imports node files for their side effects.

To add a new node type:
1. Create `src/nodes/MyNode.tsx`, call `registerNodeType(...)`.
2. Import it in `App.tsx` (side-effect import).
3. Add a default `data` case in `Canvas.tsx` `addNode()`.
4. If connectable: define a contract in `graph.ts`, call `registerContract(...)` in the node file.

### 4.3 Graph / Port System (`src/graph.ts`)

Four **protocols** flow through edges: `task-assignment`, `task-status`, `task-result`, `context`.

Each connectable node type has a `NodeInterfaceContract` declaring typed `PortDefinition` objects (direction, protocol, maxConnections). Built-in contracts:

| Contract | Node Type | Ports |
|----------|-----------|-------|
| `LEADER_CONTRACT` | leader | task-out(out), status-in(in), result-in(in), context-in(in) |
| `MINION_CONTRACT` | minion | task-in(in), status-out(out), result-out(out) |
| `CONTEXT_PROVIDER_CONTRACT` | context-provider | context-out(out) |

`canConnect(srcType, srcPort, tgtType, tgtPort)` validates direction + protocol compatibility.

`canAcceptContextConnection()` adds a runtime guard: context edges to a Leader are locked once the Leader session starts.

### 4.4 Graph Runtime (`src/graph-runtime.ts`)

`graphReducer` manages edge state (`ADD_EDGE`, `REMOVE_EDGE`, `REMOVE_EDGES_FOR_NODE`, `SET_EDGES`). `dispatchMessage()` routes `EdgeMessage` objects to target nodes. Lives in `App.tsx`.

### 4.5 Server Session Model (`server/index.ts`)

```ts
interface Session {
  id: string;              // local key
  sessionId: string|null;  // SDK conversation ID
  status: "running"|"idle"|"stopped"|"error";
  abortController: AbortController;
  queryHandle: Query|null;
  cwd: string;
  eventBuffer: BufferedEvent[];  // up to 200 events for reconnect sync
  totalCost: number; turns: number;
  role: "leader"|"minion"|"default";
  taskState: TaskManagerState|null;  // leader only
  taskName: string|null;
  worktree: WorktreeInfo|null;
  worktreeIsolation: boolean;
}
```

WebSocket command types include: `create_session`, `send_message`, `stop_session`, `sync_session`, `list_sessions`, `interrupt`, `set_permission_mode`, `set_model`, `stop_task`, and worktree commands.

### 4.6 Leader MCP Tools (`server/task-tools.ts`)

Exposed via `createSdkMcpServer` and injected into the Leader's `query()` call:

| Tool | Lifecycle effect |
|------|-----------------|
| `set_task_name` | Sets `taskName` on the session; broadcasts `session_task_name` |
| `plan_task` | Adds task record with status `planned` |
| `assign_task` | Spawns a new Minion session; status → `running` |
| `complete_task` | Leader marks task done itself; status → `completed` |
| `get_task_status` | Returns all tasks for this leader |

On every change, a `task_plan_update` WebSocket broadcast fires so the frontend stays in sync.

### 4.7 Minion MCP Tools (`server/minion-tools.ts`)

| Tool | Effect |
|------|--------|
| `report_step` | Broadcasts `minion_status` event with step message |
| `report_done` | Broadcasts completion |
| `report_fail` | Broadcasts failure |

### 4.8 Skills System (`src/skills/`)

Skills are **markdown templates** with `{{variable}}` placeholders. They are tagged onto a Leader node; `compileSkills()` replaces placeholders with user-provided values and the result is injected into the system prompt before session start.

```ts
interface SkillTemplate {
  id: string; name: string; category: ...; icon: string; accentColor: string;
  template: string;           // markdown with {{placeholders}}
  variables: SkillVariable[];
}
```

Built-in skills live under `src/skills/built-in/` (imported for side effects). User skills are stored in `localStorage` via `user-skills.ts`.

### 4.9 Git Worktree Isolation (`server/worktree.ts`)

Leaders can optionally run in a git worktree (isolated branch). Lifecycle states: `initializing → active → merging → cleaned` (or `failed`/`discarded`). Worktrees are created under `.canvas-worktrees/` in the project root. `cleanupStaleWorktrees()` runs on server start.

### 4.10 Kanban (`src/kanban-types.ts`, `src/use-kanban.ts`)

`KanbanCard` is the richer task descriptor — it holds model, permissionMode, worktreeIsolation, skillIds, linked context node IDs, and an optional `leaderNodeId` binding. Default columns: `backlog`, `in-progress`, `halted`, `history`.

---

## 5. Entry Points

| Entry | Purpose |
|-------|---------|
| `src/main.tsx` | React app mount: `ReactDOM.createRoot` → `<App />` |
| `server/index.ts` | Express + WS server, starts on `PORT` (default `3141`) |
| `pnpm start` | Runs both together: `tsx server/index.ts & vite` |

The frontend connects to `ws://localhost:3141` (configurable via `VITE_SERVER_PORT` env var).

---

## 6. Persistence

- **Per-project**: SQLite DB stored at `<projectPath>/.claude-canvas/db.sqlite` (sidecar). Schema initialised in `server/db.ts`. Tables: `projects`, `nodes`, `edges` (and likely `settings`/`context`).
- **Global index**: `~/.claude-canvas/recent-projects.json` (last 20 projects).
- **Context file**: `<projectPath>/.claude-canvas/context.md` — freeform project context injected into new sessions.
- **Canvas autosave**: `use-autosave.ts` debounces saves via the REST API.
- **Skills**: User-defined skills in `localStorage`; built-ins are bundled.

---

## 7. REST API (`server/routes/projects.ts`)

Base path: `/api/projects`. Project paths are **base64url-encoded** for URL segments.

Key endpoints (inferred from route file + `src/api.ts`):

```
GET    /api/projects                       → list recent projects
POST   /api/projects                       → create / register project
GET    /api/projects/:encodedPath          → get project with nodes
PUT    /api/projects/:encodedPath          → update project (nodes, transform)
DELETE /api/projects/:encodedPath          → remove from recent list
GET    /api/projects/:encodedPath/context  → read context.md
PUT    /api/projects/:encodedPath/context  → write context.md
GET    /api/projects/:encodedPath/settings → read settings
PUT    /api/projects/:encodedPath/settings → write settings
```

---

## 8. WebSocket Protocol (`src/use-socket.ts`)

### Client → Server commands

```
create_session      { sessionKey, cwd, systemPrompt?, model?, permissionMode?, role?, worktreeIsolation? }
send_message        { sessionKey, message }
stop_session        { sessionKey }
sync_session        { sessionKey }
list_sessions       {}
interrupt           { sessionKey }
set_permission_mode { sessionKey, mode }
set_model           { sessionKey, model }
stop_task           { sessionKey, taskId }
+ worktree commands
```

### Server → Client events (`ServerMessage` union)

```
session_list        sessions[]
session_created     sessionKey
session_status      sessionKey, status
session_error       sessionKey, error
sdk_event           sessionKey, message: SdkMessage
sync_response       sessionKey, found, status, events[], activeMinions[], …
control_response    command, sessionKey, success/error, …
session_task_name   sessionKey, taskName
task_plan_update    leaderSessionKey, tasks[]   (broadcast from task-tools)
minion_status       minionSessionKey, trigger, message  (broadcast from minion-tools)
error               message
```

---

## 9. Development Workflow

```bash
pnpm install       # install deps (note: better-sqlite3 requires native build)
pnpm start         # start both Vite dev server (5173) + WS/Express server (3141)
pnpm dev           # Vite only
pnpm server        # WS/Express server only
pnpm build         # tsc -b && vite build
pnpm typecheck     # tsc --noEmit (frontend only)
```

TypeScript config: `tsconfig.json` (root) references `tsconfig.app.json` (frontend, strict) and `tsconfig.node.json` (server). Server has its own `server/tsconfig.json`.

---

## 10. Current State & Notes

- The project is **actively developed** — many features are production-grade (WebSocket sync with event buffering, worktree lifecycle, Kanban board, skills system).
- **Canvas + graph state** lives in `App.tsx` (`useReducer` for nodes via `canvasReducer`, `useReducer` for edges via `graphReducer`). Both are persisted via `useAutosave`.
- **Session reconnection**: `sync_session` replays up to 200 buffered events when a browser tab reconnects.
- **No test suite** was observed in the project. Type-checking (`pnpm typecheck`) is the primary correctness gate.
- **`.canvas-worktrees/`** directory in the project root is created by the worktree feature — add to `.gitignore`.
- **Sidecar directory** `.claude-canvas/` is created at the project root for SQLite + context.md — add to `.gitignore`.
- `better-sqlite3` requires a native build; if `pnpm install` fails on it, run `pnpm rebuild better-sqlite3`.
- `VITE_SERVER_PORT` env var overrides the WS/Express port (default `3141`).
