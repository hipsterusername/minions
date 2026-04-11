# Minions

A canvas for managing agentic context and workflows. Give a Leader agent a complex task, and it automatically spawns parallel Minion agents that collaborate in real time.

> **Status**: Early development. Shared for private testing — expect rough edges.

---

## What This Is

Minions gives you a spatial interface on top of Claude Code:

- **Infinite canvas** — drag, zoom, arrange nodes visually
- **Leader/Minion orchestration** — give a Leader a complex task, and it automatically spawns Minion agents, wires them up, and tracks progress through a live task board
- **Kanban board** — plan work as cards with priorities, models, and skills, then launch Leaders directly from the board
- **Git worktree isolation** — each Minion works in its own worktree so parallel agents don't conflict
- **Skills browser** — browse, create, and launch pre-configured skill templates
- **Project management** — persistent projects with SQLite storage, session history, cost tracking

## Prerequisites

You need all of the following installed before starting:

| Requirement | Why |
|---|---|
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** | Canvas runs Claude sessions through the Agent SDK — you must have `claude` CLI installed and authenticated |
| **Node.js ≥ 22** | Required by the Agent SDK and modern ES features |
| **pnpm** | Package manager (`npm install -g pnpm` if you don't have it) |
| **git** | Used for worktree isolation when running parallel agents |

### Verify your setup

```bash
pnpm preflight
```

This checks all prerequisites and tells you what's missing.

## Quick Start

```bash
git clone <repo-url>
cd minions
pnpm install
pnpm start
```

The app opens automatically at **http://localhost:5173**. The backend server runs on port 3141.

That's it. No environment variables, no database setup, no Docker — SQLite handles storage automatically.

## Usage

### Leader/Minion Orchestration

1. Click the **+** button on the canvas toolbar and add a **Leader** node
2. Give the Leader a complex task — it plans the work and automatically spawns **Minion** agents
3. Minion nodes appear on the canvas, automatically wired to the Leader
4. Each Minion works independently in its own git worktree
5. The Leader tracks progress, integrates results, and reports back

> Minion nodes are created and wired automatically — you never need to add or connect them manually.

### Kanban Board

1. Switch to the **Kanban** view from the project header
2. Create cards in the **Backlog** column with descriptions, priority, model, and skills
3. Click **Launch Leader** on a card to spawn a Leader on the canvas
4. Cards move through columns automatically as work progresses (In Progress → Ready for Review → Agent History)

### Other Node Types

Click **+** on the canvas toolbar to add:

- **Leader** — orchestrator agent that decomposes work and delegates to Minions
- **Note** — sticky notes for quick reminders on the canvas
- **Markdown** — rich documentation and notes
- **Context Group** — group context together to feed into Leader sessions

## Configuration

All optional — sane defaults are provided:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3141` | Backend server port |
| `HOST` | `127.0.0.1` | Server bind address |

Set them as environment variables:

```bash
PORT=8080 pnpm start
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm start` | Run everything (server + frontend dev) |
| `pnpm dev` | Vite frontend only (hot reload) |
| `pnpm server` | Backend server only |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm preflight` | Validate prerequisites |

## Architecture

```
Browser (localhost:5173)
  │
  ├── React 19 + Vite 8 (infinite canvas UI)
  │
  └── WebSocket ──► Express server (localhost:3141)
                      │
                      ├── Claude Agent SDK ──► claude CLI sessions
                      ├── SQLite (per-project state)
                      ├── MCP tools (task management, render dashboard)
                      └── Git worktree manager (agent isolation)
```

### Key directories

```
src/                  Frontend React application
  nodes/              Node type components (ClaudeSession, Leader, Minion, etc.)
  prompts/            System prompts for Leader/Minion behavior
  components/         Shared UI components
server/               Backend Express + WebSocket server
  routes/             REST API route handlers
  task-tools.ts       MCP tools for Leader task management
  minion-tools.ts     MCP tools for Minion reporting
  worktree.ts         Git worktree lifecycle management
scripts/              Utility scripts (preflight checks)
```

## Troubleshooting

**"claude: command not found"**
Install Claude Code and sign in: https://docs.anthropic.com/en/docs/claude-code

**Sessions fail to start**
Make sure `claude` works on its own first — run `claude` in your terminal to verify authentication.

**Port already in use**
Another instance may be running. Kill it or use a different port: `PORT=3142 pnpm start`

**Native module build errors during `pnpm install`**
`better-sqlite3` requires a C++ compiler. On macOS run `xcode-select --install`. On Ubuntu/Debian: `sudo apt install build-essential`.

---

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
