# Minions — Developer Context

> Generated 2026-04-11. Read time: ~5–7 minutes.
> **Status**: Early development, private testing. Expect rough edges.

---

## 1. What Is This?

**Minions** is a spatial canvas UI for orchestrating multi-agent Claude Code AI workflows. A user opens any project directory, places nodes on an infinite canvas, and directs a **Leader** agent with a complex task. The Leader automatically plans work, spawns parallel **Minion** agents (each isolated in a git worktree), tracks their progress on a live task board, and integrates results — all visualized in real time.

Key features:
- **Infinite canvas** — drag, zoom, arrange agent nodes spatially
- **Leader/Minion orchestration** — Leader plans, delegates, and monitors; Minions execute
- **Kanban board** — card-based task planning with per-card model/skill/worktree config
- **Git worktree isolation** — each Leader session runs in its own `git worktree` branch
- **Live render dashboard** — Leader pushes structured UI components (metrics, tables, charts) to a side panel
- **Skills browser** — parameterizable Markdown templates injected into Leader system prompts
- **Persistent projects** — per-project SQLite databases, session history, cost tracking

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19.2, Vite 8, TypeScript 5.9 (strict) |
| Backend | Node.js ≥22, Express 5, `tsx` runtime |
| Realtime | WebSocket (`ws` v8) — port **3141** |
| AI Runtime | `@anthropic-ai/claude-agent-sdk` ^0.2.86 — wraps `claude` CLI |
| MCP Tools | `createSdkMcpServer` + `tool` from the SDK (task, render, minion-status tools) |
| Storage | `better-sqlite3` (per-project SQLite sidecar) + global JSON index |
| Validation | Zod 4 |
| Package manager | pnpm |

No external services, no Docker, no `.env` required for normal use.

---

## 3. Architecture

```
Browser (localhost:5173)
  │
  ├── React 19 + Vite 8 (infinite canvas UI)
  │     App.tsx → Canvas + KanbanBoard + SkillsBrowser
  │
  └── WebSocket (token auth) ──► Express server (localhost:3141)
                                    │
                                    ├── REST API  /api/projects/*  /api/files/*
                                    │
                                    ├── Claude Agent SDK
                                    │     query() → claude CLI session per node
                                    │
                                    ├── MCP Tool Servers (in-process, per-session)
                                    │     task-manager    → Leader orchestration
                                    │     render-dashboard → live UI dashboard
                                    │     minion-status   → step/done/fail reports
                                    │
                                    └── Git worktree manager
                                          .canvas-worktrees/<sessionKey>/
```

### Key Directories

```
src/                          Frontend React application
  main.tsx                    Entry point → <App />
  App.tsx                     Root: ProjectList ↔ ProjectView; orchestrates all state
  Canvas.tsx                  Infinite canvas (pan, zoom, node drag/resize, edge rendering)
  CanvasNode.tsx              Node wrapper (drag, select, port dots, drop-target highlight)
  EdgeRenderer.tsx            SVG bezier edges with animated dash overlays

  nodes/                      One file per node type (each calls registerNodeType)
    LeaderNode.tsx            Orchestrator — LeaderData, TaskPlanItem, worktree controls
    MinionNode.tsx            Worker session — MinionData, step/done/fail display
    ClaudeSessionNode.tsx     Generic Claude session (older direct-use node)
    MarkdownNode.tsx          Editable markdown sticky note (context provider)
    FileViewerNode.tsx        Read-only file viewer (context provider)
    FolderNode.tsx            Directory browser node
    ContextGroupNode.tsx      Groups context nodes to feed into a Leader
    RenderNode.tsx            Displays Leader's live render dashboard

  prompts/                    System prompts injected at session start
    leader-system.ts          LEADER_SYSTEM_PROMPT (full orchestration instructions)
    minion-system.ts          MINION_SYSTEM_PROMPT (executor instructions)
    context-explorer.ts       CONTEXT_EXPLORER_PROMPT (spawned via ProjectPanel)
    card-creation-system.ts   CardCreationChat system prompt

  skills/                     Skill template system
    types.ts                  SkillTemplate, SkillVariable, compileSkills(), extractVariableNames()
    registry.ts               registerSkill(), getSkill(), getAllSkills() (in-memory)
    user-skills.ts            Per-project skill persistence (localStorage + /api/projects/:id/skills)
    built-in/                 12 bundled skill templates (commit, debug, refactor, etc.)

  components/                 Shared UI primitives
    SessionToolbar.tsx        Model selector, permission mode, start/stop controls, worktree toggle
    StreamingBubble.tsx       Streaming text display with thought-bubble style
    StatusBanner.tsx          Inline status notification stack
    SimpleMarkdown.tsx        Lightweight markdown renderer
    AutoTextarea.tsx          Auto-growing textarea
    PortDot.tsx               Edge connection port dot (context-in / context-out)
    ResizeHandle.tsx          Node resize drag handle
    ProjectTree.tsx           File tree widget (used in ProjectPanel)
    ConfirmModal.tsx          Generic confirmation dialog
    CopyButton.tsx            One-click clipboard copy
    AddAsNodeButton.tsx       "Add response as node" button on AI messages
    CanvasContextMenu.tsx     Right-click context menu

  canvas-state.ts             canvasReducer + useCanvasHistory (50-deep undo/redo)
  canvas-utils.ts             viewportCenter(), findNonOverlappingPosition()
  graph.ts                    Port/protocol definitions, NodeInterfaceContract, canConnect()
  graph-runtime.ts            graphReducer, createEdge(), edge validation + CRUD
  render-dsl.ts               RenderComponent types, RenderMessage, applyRenderMessage()
  sdk-messages.ts             Full SdkMessage union (23 types) + type guards
  streaming.ts                Stream delta extraction helpers
  use-socket.ts               useSocket hook (connect, auth, reconnect, pub/sub)
  use-autosave.ts             Debounced canvas state persistence
  use-kanban.ts               Kanban board state hook + reducer
  use-canvas-keyboard.ts      Canvas keyboard shortcuts (delete, undo, redo, etc.)
  use-canvas-file-drop.ts     Drag-and-drop file → FileViewerNode
  use-theme.ts                Theme context + persist/load helpers
  kanban-types.ts             KanbanCard, KanbanBoard, KanbanAction types
  node-defaults.ts            Default data factories per node type
  node-registry.ts            registerNodeType() / getNodeType() / getUserCreatableNodeTypes()
  palette.ts                  Color palette constants
  themes.ts                   Theme definitions + applyTheme()
  auto-layout.ts              Auto-layout algorithm for node positioning
  types.ts                    Core types: CanvasNode, NodeTypeDefinition, NodeRenderProps, etc.
  api.ts                      Typed REST API client (auth token, CRUD, skills, tree)

server/
  index.ts                    Express + WebSocketServer + session lifecycle (~700 lines)
  db.ts                       SQLite schema init (projects + nodes tables)
  project-store.ts            Per-project sidecar DB, context.md, settings, skills, recent list
  worktree.ts                 Git worktree CRUD (create/merge/discard/status/cleanup)
  task-tools.ts               MCP server: plan_task, assign_task, complete_task, get_task_status,
                                set_task_name, wait_and_continue, request_approval
  render-tools.ts             MCP server: render_set, render_patch, render_append, render_remove
  minion-tools.ts             MCP server: report_step, report_done, report_fail
  path-guard.ts               validateSessionCwd() — prevents path traversal
  routes/
    projects.ts               REST handlers for /api/projects/* (CRUD, context, settings, skills, tree)
    files.ts                  REST handlers for /api/files/*

scripts/
  dev.mjs                     Orchestrates server + vite in parallel (pnpm start)
  preflight.mjs               Checks Node ≥22, pnpm, claude CLI, git
  setup-permissions.mjs       Auto-configures Claude Code MCP tool permissions
```

---

## 4. Key Abstractions

### 4.1 Canvas Nodes (`src/types.ts`)

```ts
interface CanvasNode<T = unknown> {
  id: string;
  type: string;        // "leader" | "minion" | "markdown" | "file-viewer" | ...
  position: Position;  // { x, y }
  size: Size;          // { width, height }
  data: T;             // node-type-specific payload
}
```

`CanvasAction` is a discriminated union driving `canvasReducer`:
`ADD_NODE | REMOVE_NODE | MOVE_NODE | RESIZE_NODE | UPDATE_NODE_DATA | SET_NODES | MOVE_GROUP`

`useCanvasHistory` wraps the reducer with a 50-deep undo/redo history stack. `SET_NODES` is excluded from history (used for loading saved state).

### 4.2 Node Registration Pattern

Each node file in `src/nodes/` calls `registerNodeType(def)` as a **module side effect**. `App.tsx` imports these files for their side effects at the top.

```ts
// In any node file:
registerNodeType({
  type: "my-node",
  label: "My Node",
  defaultSize: { width: 320, height: 240 },
  render: MyNodeComponent,
  userCreatable: true,   // appears in canvas toolbar
  autoHeight: false,     // grows with content if true
});
```

**To add a new node type:**
1. Create `src/nodes/MyNode.tsx`, define and call `registerNodeType(...)`
2. Add a side-effect import in `src/App.tsx`
3. Optionally define edge contracts via `registerContract()` in the node file

### 4.3 LeaderNode Data (`src/nodes/LeaderNode.tsx`)

```ts
interface LeaderData {
  sessionKey: string | null;
  status: "disconnected" | "creating" | "running" | "idle" | "stopped" | "error";
  messages: LeaderMessage[];
  streamingText: string;
  totalCost: number;
  turns: number;
  error: string | null;
  model: ModelOption;           // "sonnet" | "opus" | "haiku" | ...
  permissionMode: PermissionMode;
  taskPlan: TaskPlanItem[];
  worktreeIsolation: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeStatus: "none" | "creating" | "active" | "merging" | "merged" | "discarded" | "failed";
  taskName: string | null;      // set by set_task_name MCP tool
  autoStartPrompt?: string;     // if set, session starts immediately on mount
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
  skillPanelOpen: boolean;
}
```

`TaskPlanItem` mirrors the server's `TaskRecord` with added `cost`, `sessionSummary`, and frontend-only fields.

### 4.4 Task Manager MCP Tools (`server/task-tools.ts`)

Injected as an in-process MCP server into every Leader's `query()` call:

| Tool | Effect |
|---|---|
| `plan_task(taskId, title, description, priority)` | Registers task as `planned`; broadcasts `task_plan_update` |
| `assign_task(taskId, title, description, priority)` | Spawns a Minion session; transitions to `running`; broadcasts `minion_spawned` |
| `complete_task(taskId, result)` | Leader marks task done itself; transitions to `completed` |
| `get_task_status(taskId?)` | Returns one or all `TaskRecord`s |
| `set_task_name(name)` | Sets display name; broadcasts `session_task_name` |
| `wait_and_continue(duration_seconds, reason)` | Pauses 5s–30min; system resumes with "Continue"; broadcasts `wait_state` |
| `request_approval(summary)` | Gathers a detailed diff and requests user approval to merge worktree; only available when worktree isolation is active |

`TaskRecord` lifecycle: `planned → running → completed | failed`

### 4.5 Render Dashboard DSL (`src/render-dsl.ts`, `server/render-tools.ts`)

Leader agents push live UI components to a `RenderNode` on the canvas. Operations:

| Operation | What it does |
|---|---|
| `render_set` | Replace entire dashboard |
| `render_patch` | Update components by `id` |
| `render_append` | Add new components |
| `render_remove` | Remove components by `id` |

Component types: `metric`, `progress`, `status`, `table`, `list`, `text`, `code` — each requires a unique `id` for patching.

### 4.6 Minion Status Tools (`server/minion-tools.ts`)

Injected into every Minion's `query()`:

| Tool | Broadcasts |
|---|---|
| `report_step(message)` | `minion_status { trigger: "step" }` |
| `report_done(summary)` | `minion_status { trigger: "done" }` |
| `report_fail(reason)` | `minion_status { trigger: "fail" }` |

### MCP Tool Permissions

All three MCP servers (`task-manager`, `render-dashboard`, `minion-status`) are in-process servers created per-session via `createSdkMcpServer`. Their tools must be explicitly allowed in the `allowedTools` array passed to the SDK `query()` call, using the `mcp__<server>__<tool>` naming convention.

This is handled in `server/index.ts` where `fullTools` is assembled per role:
- **Leader** sessions get `codeTools` + all `task-manager` and `render-dashboard` MCP tools (11 tools)
- **Minion** sessions get `codeTools` + all `minion-status` MCP tools (3 tools)
- **Generic** sessions get `codeTools` only

Permissions are passed inline with each `query()` call so they work regardless of session `cwd` (important for worktree-isolated sessions that run outside the project root). The project-level `.claude/settings.json` (written by `pnpm configure`) serves as a fallback and documents the full permission set.

### 4.7 Skills System (`src/skills/types.ts`)

Skills are Markdown templates with `{{variable_name}}` placeholders:

```ts
interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  category: "code" | "docs" | "testing" | "devops" | "analysis" | "design" | "general";
  icon: string;
  accentColor: string;       // hex
  template: string;          // Markdown with {{placeholders}}
  variables: SkillVariable[];
}
```

`compileSkills(skills, allValues)` replaces placeholders and joins all skills into an `# Active Skills` section appended to the system prompt.

12 built-in skills: `refactor`, `debug`, `commit`, `explain`, `code-review`, `test-generator`, `documentation`, `architect`, `api-design`, `frontend-design`, `performance`, `security-audit`, `simplify`.

User skills persist per-project via `/api/projects/:id/skills`. The `user-skills.ts` module handles both localStorage (legacy) and API storage.

### 4.8 Graph / Port System (`src/graph.ts`, `src/graph-runtime.ts`)

Edges connect nodes through typed ports. `NodeInterfaceContract` declares valid port definitions per node type.

Built-in contracts:
- `LEADER_CONTRACT` — ports: `context-in` (in), `task-out` (out), `status-in` (in), `result-in` (in)
- `MINION_CONTRACT` — ports: `task-in` (in), `status-out` (out), `result-out` (out)
- `CONTEXT_PROVIDER_CONTRACT` — port: `context-out` (out)

`canConnect(srcType, srcPort, tgtType, tgtPort)` validates direction + protocol compatibility. Context edges to a Leader are locked once the Leader session starts (runtime guard in `canAcceptContextConnection()`).

`graphReducer` manages edge CRUD: `ADD_EDGE | REMOVE_EDGE | REMOVE_EDGES_FOR_NODE | SET_EDGES`.

### 4.9 Git Worktree Isolation (`server/worktree.ts`)

Each Leader session optionally runs in its own git worktree:

```
Lifecycle: initializing → active → merging → cleaned
                       ↘ failed             (merge had conflicts → stays active)
                       ↘ discarded          (user chose to discard)
```

Worktrees are created at `<projectPath>/.canvas-worktrees/<sessionKey>/` on branch `canvas/<sessionKey>`.

Key functions: `createWorktree()`, `removeWorktree()`, `mergeAndCleanup()`, `getWorktreeStatus()`, `isGitRepo()`, `cleanupStaleWorktrees()`.

### 4.10 Kanban Board (`src/kanban-types.ts`, `src/use-kanban.ts`)

`KanbanCard` holds: `title`, `description`, `subtasks`, `priority`, `model`, `permissionMode`, `worktreeIsolation`, `skillIds`, `skillValues`, `linkedContextNodeIds`, `leaderNodeId` (binding to canvas node).

Default columns: `backlog → in-progress → halted → history`

Auto-transitions (in `App.tsx`):
- Leader becomes `idle/stopped` with active worktree → card auto-moves to `halted`
- Leader disconnects → card auto-halts with reason `"session_lost"`
- Leader session error → card auto-halts with reason `"error"`
- User sends message → leader resumes → card auto-resumes from `halted`
- Worktree merged/discarded → card auto-archives to `history`

Canvas → Kanban reconciliation: any active Leader node without a card gets one auto-created.

### 4.11 WebSocket Auth & Connection (`src/use-socket.ts`)

- Auth token fetched once from `GET /api/auth/token` (localhost only, no auth header needed)
- Token passed as `?token=<value>` query param on WS upgrade
- `useSocket(url)` returns `{ connected, reconnectState, send, subscribe, manualReconnect }`
- Reconnect: exponential backoff 2s → 30s, max 10 attempts; `±500ms` jitter
- Unknown message types are silently rejected (whitelist of ~16 known types)

---

## 5. Entry Points

| What | File |
|---|---|
| Browser app root | `src/main.tsx` → `src/App.tsx` |
| Backend server | `server/index.ts` (via `npx tsx server/index.ts`) |
| Dev orchestrator | `scripts/dev.mjs` — starts both |
| Vite config | `vite.config.ts` |
| TypeScript configs | `tsconfig.json` (root refs), `tsconfig.app.json` (src), `tsconfig.node.json` (server+scripts), `server/tsconfig.json` |

---

## 6. Development Workflow

### Prerequisites

```bash
# Check everything:
pnpm preflight
```

Requires: Node.js ≥22, pnpm, `claude` CLI (authenticated), git.

### Commands

```bash
pnpm install         # install deps (better-sqlite3 requires C++ compiler)
pnpm configure           # preflight checks + auto-configure Claude Code MCP permissions
pnpm start           # server + Vite dev → http://localhost:5173
pnpm dev             # Vite frontend only (hot reload)
pnpm server          # Express/WS backend only
pnpm build           # tsc -b + vite build (production)
pnpm typecheck       # tsc --noEmit (type checking without emit)
pnpm preflight       # validate prerequisites only
```

### First-Time Setup

After `pnpm install`, run **`pnpm configure`** to validate prerequisites and auto-configure Claude Code permissions for all MCP tools (task-manager, render-dashboard, minion-status). This is required for the Leader/Minion orchestration to work without interactive permission prompts.

If `pnpm configure` fails or you prefer manual configuration, see `scripts/setup-permissions.mjs` for the full list of required tool permissions.

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3141` | Backend HTTP + WS port |
| `HOST` | `127.0.0.1` | Server bind address |
| `VITE_SERVER_PORT` | `3141` | Frontend WS URL override |

No `.env` file needed; set inline: `PORT=8080 pnpm start`

---

## 7. REST API

Base path: `/api`. Project paths are **base64url-encoded** for URL segments.

```
GET    /api/auth/token                          Fetch WS auth token (localhost only, no auth)

GET    /api/projects                            List recent projects
POST   /api/projects                            Create/register a project { name, path }
POST   /api/projects/open                       Open an existing directory { path }
GET    /api/projects/:encodedId                 Get project with all nodes
PUT    /api/projects/:encodedId                 Update project name/transform
DELETE /api/projects/:encodedId                 Remove from recent list
PUT    /api/projects/:encodedId/state           Save canvas state { nodes, transform }
GET    /api/projects/:encodedId/context         Read context.md
PUT    /api/projects/:encodedId/context         Write context.md { content }
GET    /api/projects/:encodedId/settings        Read settings
PUT    /api/projects/:encodedId/settings        Write settings
GET    /api/projects/:encodedId/skills          Read per-project skills
PUT    /api/projects/:encodedId/skills          Write per-project skills
GET    /api/projects/:encodedId/tree?depth=N    Get directory tree

GET    /api/files/*                             Serve project files
```

---

## 8. WebSocket Protocol

Auth: `?token=<value>` query param. Max payload: 1MB.

### Client → Server

```
create_session     { sessionKey, cwd, systemPrompt, prompt, model, permissionMode,
                     role, worktreeIsolation, initData }
send_message       { sessionKey, message }
stop_session       { sessionKey }
sync_session       { sessionKey, sessionId? }      # reconnect + replay events
list_sessions      {}
interrupt          { sessionKey }
set_permission_mode { sessionKey, mode }
set_model          { sessionKey, model }
merge_worktree     { sessionKey }
discard_worktree   { sessionKey }
get_worktree_status { sessionKey }
```

### Server → Client (broadcasts)

```
session_created       sessionKey
session_status        sessionKey, status
session_error         sessionKey, error
sdk_event             sessionKey, message: SdkMessage
sync_response         sessionKey, found, status, events[], activeMinions[], taskName, ...
control_response      command, sessionKey, success, [extra fields]
session_task_name     sessionKey, taskName
task_plan_update      leaderSessionKey, tasks[]
minion_spawned        leaderSessionKey, minionSessionKey, taskId, title, priority, worktreeBranch
minion_status         minionSessionKey, trigger ("step"|"done"|"fail"), message
render_update         leaderSessionKey, action, [components | updates | ids]
wait_state            sessionKey, action ("started"), durationMs, reason, scheduledAt
worktree_created      leaderSessionKey, path, branch
worktree_failed       leaderSessionKey, error
```

---

## 9. Persistence

| What | Where |
|---|---|
| Canvas nodes | `<project>/.claude-canvas/canvas.db` — SQLite `nodes` table (data as JSON string) |
| Project metadata | Same DB — `projects` table (name, transform_x/y/scale) |
| context.md | `<project>/.claude-canvas/context.md` (plain file) |
| Settings | `<project>/.claude-canvas/settings.json` |
| Per-project skills | `<project>/.claude-canvas/skills.json` |
| Recent projects | `~/.claude-canvas/recent-projects.json` |
| Worktrees | `<project>/.canvas-worktrees/<sessionKey>/` (git worktrees) |

Both `.claude-canvas/` and `.canvas-worktrees/` should be in `.gitignore`.

Session event buffers (up to 200 events) live in-memory on the server for reconnect replay.

---

## 10. SdkMessage Union (`src/use-socket.ts`)

The frontend models all 23 Claude Agent SDK message types as a discriminated union `SdkMessage`. Key subtypes:

- **System messages** (14 subtypes): `init`, `status`, `api_retry`, `local_command_output`, `compact_boundary`, `session_state_changed`, `files_persisted`, `elicitation_complete`, `hook_started`, `hook_progress`, `hook_response`, `task_started`, `task_progress`, `task_notification`
- **Non-system**: `assistant`, `stream_event`, `user`, `result` (success/error), `tool_progress`, `tool_use_summary`, `auth_status`, `rate_limit_event`, `prompt_suggestion`

Type guards: `isSystemMessage`, `isAssistantMessage`, `isResultSuccess`, `isResultError`, `isStreamEvent`, `isSystemSubtype<S>(msg, subtype)`, etc.

---

## 11. Current State & Known Caveats

- **No test suite** — TypeScript (`pnpm typecheck`) is the primary correctness gate
- `server/index.ts` is large (~700+ lines) — handles session lifecycle, WS routing, worktree management, and minion spawning in one file
- `better-sqlite3` requires native C++ — on macOS: `xcode-select --install`; Linux: `sudo apt install build-essential`
- `ClaudeSessionNode` is an older generic node; `LeaderNode` is the primary orchestration entry point
- Skills have two persistence paths: `localStorage` (legacy, user-wide) and the per-project API endpoint (current). `user-skills.ts` bridges both
- The project DB `id` is the **base64url-encoded absolute path** of the project directory — this is used in all REST URLs
- Context window compaction is handled transparently by the Claude Agent SDK; `SdkCompactBoundaryMessage` events surface in the message history UI
- The `autoStartPrompt` field on `LeaderData` causes a Leader node to start a session immediately upon mounting — used for Kanban card launches and Skills browser
- `wait_and_continue` wires through `scheduleWaitContinue` callback in `server/index.ts` which injects a "Continue" message after the timer fires, resuming the leader's `query()` loop
