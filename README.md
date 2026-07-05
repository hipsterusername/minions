# Minions

A canvas for managing agentic context and workflows. Give a Leader agent a complex task, and it spawns parallel Minion agents that collaborate in real time.

> **Status**: Early development. Shared for private testing — expect rough edges.

---

## What This Is

Minions gives you a spatial interface on top of Claude Code:

- **Infinite canvas** — drag, zoom, arrange nodes visually
- **Leader/Minion orchestration** — give a Leader a complex task, and it spawns Minion agents, wires them up, and tracks progress through a live task board
- **Kanban board** — plan work as cards with priorities, models, and skills, then launch Leaders directly from the board
- **Git worktree isolation** — each Minion works in its own worktree so parallel agents don't conflict, and changes route through an explicit approval flow before merging
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
It also listens on your Tailscale interface by default, so you can open
`http://<tailscale-hostname-or-ip>:5173` from another device on your tailnet.

That's it. No environment variables, no database setup, no Docker — SQLite handles storage automatically.

## Usage

### Leader/Minion Orchestration

1. Click the **+** button on the canvas toolbar and add a **Leader** node
2. Give the Leader a complex task — it plans the work and spawns **Minion** agents
3. Minion nodes appear on the canvas, automatically wired to the Leader
4. Minions run inside the Leader's isolated worktree, so parallel tasks should own disjoint files
5. The Leader tracks progress, integrates results, and routes the shared worktree through approval

> Minion nodes are created and wired automatically — you never need to add or connect them manually.

### Kanban Board

1. Switch to the **Kanban** view from the project header
2. Create cards in the **Backlog** column with descriptions, priority, model, and skills
3. Click **Launch Leader** on a card to spawn a Leader on the canvas
4. Cards move through columns automatically as work progresses (In Progress → Ready for Review → Agent History)

### Other Node Types

Click **+** on the canvas toolbar to add:

- **Leader** — orchestrator agent that decomposes work and delegates to Minions
- **Markdown** — rich documentation and notes
- **Image** — drop in screenshots or diagrams as canvas context
- **Dashboard** — render DSL component view (also driven by Leader render tools)
- **Context Group** — group nodes together to feed as context into Leader sessions

Folder and File Viewer nodes are created automatically when you drag in directories or files.

## Configuration

All optional — sane defaults are provided:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3141` | Backend server port |
| `HOST` | `0.0.0.0` | Server bind address |

Set them as environment variables:

```bash
PORT=8080 pnpm start
```

Remote browser access is limited to loopback and Tailscale-style hosts
(`100.64.0.0/10`, Tailscale IPv6, and MagicDNS `*.ts.net`). The browser talks to
the backend same-origin — Vite proxies both `/api` and the `/ws` WebSocket to the
server — so changing `PORT` alone is enough; the front end follows automatically:

```bash
PORT=8080 pnpm start
```

### Mobile access over HTTPS (Tailscale)

The mobile companion at `/m` uses **Web Push** for notifications, and browsers
only expose the Service Worker / Push APIs in a **secure context** (HTTPS, or
`localhost`). Opening the app from a phone over `http://<host>:5173` is *not* a
secure context, so the notifications button shows **"Notifications Unsupported"**.

Serve the app over real HTTPS on your tailnet — no self-signed certs:

```bash
# Terminal 1 — run the app (built preview is best for a phone):
pnpm build && pnpm preview        # serves the built app on :4173

# Terminal 2 — front it over tailnet HTTPS on :443:
pnpm serve:tailscale              # tailscale serve → https://<machine>.<tailnet>.ts.net
```

Then open `https://<machine>.<tailnet>.ts.net/m` on your phone (small screens
auto-redirect to `/m`). Notifications now work: tap **Enable notifications**.

- Fronting the **dev** server instead: `pnpm serve:tailscale:dev` (port 5173).
- Stop fronting: `node scripts/tailscale-serve.mjs --off`.
- On **iOS**, Web Push additionally requires iOS 16.4+ and adding the app to the
  Home Screen (Share → *Add to Home Screen*), then launching it from that icon.

This stays tailnet-only; it does not enable `tailscale funnel` (public internet).

To pre-approve all in-process MCP tools so the Leader/Minion flow runs without interactive permission prompts:

```bash
pnpm configure
```

This writes a project-level allowlist to `.claude/settings.json`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm start` | Run everything (server + frontend dev) |
| `pnpm dev` | Vite frontend only (hot reload) |
| `pnpm server` | Backend server only |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm test` | Run vitest in watch mode |
| `pnpm test:run` | Run all tests once (used by CI) |
| `pnpm test:coverage` | Run all tests once and produce a coverage report |
| `pnpm verify` | Run the full CI gate locally (typecheck + test:run + build) |
| `pnpm preflight` | Validate prerequisites |
| `pnpm configure` | Run preflight, then pre-approve all in-process MCP tools |

## Testing & development workflow

Tests are required for all behavioural changes. The full strategy is in
[`docs/testing-strategy.md`](./docs/testing-strategy.md).

The short version:

1. **Before pushing**, run `pnpm verify` (typecheck + test:run + build).
   CI runs the same gate and will fail the PR otherwise.
   For an even tighter local loop, install `prek` once
   (`prek install`) — the hook config in `.pre-commit-config.yaml`
   will run typecheck + tests on every commit.
2. **When refactoring**, write a test that captures the current behaviour
   *before* you change the code. The test should pass on `main`, then
   pass unchanged on your branch. If it had to change, you changed
   behaviour — call that out in the PR.
3. **When fixing a bug**, write a failing test first, then make it pass.
   The test stays in the suite.
4. **Test files live next to the code they test** (`src/foo.ts` →
   `src/foo.test.ts`). Cross-tree contract tests live under
   `tests/contracts/`; architecture-fitness tests under
   `tests/architecture/`.

The architecture-fitness suite encodes invariants enforced in CI:
server file size ceilings (≤ 400 lines), no cross-tree imports between
`src/` and `server/`, broadcasts only through `server/bus.ts`, and a
handler registered for every WebSocket command.

## Architecture

```
Browser (localhost:5173 or Tailscale host:5173)
  │
  ├── React 19 + Vite 8 (infinite canvas UI)
  │
  └── WebSocket ──► Express server (same host:3141)
                      │
                      ├── Claude Agent SDK ──► claude CLI sessions
                      ├── SQLite (per-project state)
                      ├── MCP tools (task management, render dashboard)
                      └── Git worktree manager (agent isolation)
```

### Key directories

```
src/                  Frontend React application
  nodes/              Node type components (Leader, Minion, ClaudeSession, …)
  prompts/            System prompts shared with the frontend
  components/         Shared UI components
server/               Backend Express + WebSocket server
  agents/             Per-agent (leader, minion, default) wiring
  commands/           Per-command WebSocket handlers
  routes/             REST API route handlers
  task-tools/         MCP tools for Leader task management
  minion-tools.ts     MCP tools for Minion reporting
  render-tools.ts     MCP tools for Dashboard render DSL
  bus.ts              Typed event bus — all broadcasts go through here
  worktree*.ts        Git worktree lifecycle and approval flow
scripts/              Utility scripts (preflight, permission setup)
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
