# Public Onboarding & Standalone Startup — Design

Status: **Proposal (pre-implementation).** This document traces the current
startup paths, maps the failures, and proposes a public command model,
prerequisite matrix, first-run journey, and a staged implementation plan.
No commands are edited and no work is delegated until this plan is approved.

Handoff source: `.recovery/open-source-handoffs/public-onboarding.md`.

---

## 1. Current-state journey map

What a new user actually hits today, path by path (verified against
`package.json`, `scripts/*.mjs`, and `README.md`).

### The documented "Quick Start"

```
git clone … && cd minions
pnpm install          # builds better-sqlite3 (needs C++ toolchain)
pnpm preflight        # checks Node≥22, pnpm, git, CLAUDE_CODE_PATH only
pnpm start            # ← configures Tailscale FIRST, fails closed, then detaches
```

`pnpm start` (`scripts/start.mjs`):
1. `enableTailscaleServe()` runs **before** anything else. If `tailscale serve`
   cannot be configured, it prints an error and `process.exit()` — the app never
   starts. **Tailscale is a hard dependency of the default start command.**
2. Spawns `scripts/dev.mjs` **detached**, stdio redirected to `.run/minions.log`,
   PID in `.run/minions.pid`. Terminal returns immediately; no inline output.
3. `dev.mjs` runs `npx tsx server/index.ts` + `npx vite --port 6173 --strictPort
   --open` in the foreground *of the detached process*.

### The command surface today

| Command | Backend | Frontend | Tailscale | Foreground? | Notes |
|---|---|---|---|---|---|
| `pnpm start` | ✅ | ✅ | **required** | ❌ detached | logs to file, fails closed on Tailscale |
| `pnpm dev` | ❌ | ✅ | no | ✅ | **frontend only — WS/API calls fail** |
| `pnpm server` | ✅ | ❌ | no | ✅ | backend only; `npx tsx` |
| `pnpm stop/restart/status` | — | — | toggles | — | manages the detached service |
| `pnpm preview` | ❌ | built | no | ✅ | serves a prior `pnpm build` |
| `pnpm serve:tailscale[:dev]` | — | — | ✅ | — | HTTPS front only |
| `scripts/dev.mjs` (unbound) | ✅ | ✅ | no | ✅ | **a real foreground full-stack loop exists but no script exposes it** |

The single most important structural fact: **a clean foreground localhost
full-stack loop already exists in `dev.mjs` but is only reachable by running it
detached through `pnpm start`, which forces Tailscale.** The safest path is
implemented but hidden behind the least safe one.

---

## 2. Failure matrix

| # | Failure | Where | Impact | Root cause |
|---|---|---|---|---|
| F1 | New user with no Tailscale cannot start the app at all | `start.mjs` `enableTailscaleServe()` exits non-zero | **Blocker** | Remote-access concern coupled into the default start |
| F2 | `pnpm dev` looks like "run the app" but only starts Vite; every session/WS call fails | `package.json` `"dev":"vite"` | High confusion | No foreground full-stack script is bound |
| F3 | Detached-by-default hides errors in a log file; nothing streams to the terminal | `start.mjs` stdio→`minions.log` | High | Service-management semantics chosen as the default UX |
| F4 | `preflight` validates Claude only; never checks Codex, Tailscale, native build toolchain, or real auth | `preflight.mjs` | Medium | Preflight describes defaults instead of testing prerequisites |
| F5 | README/prereqs read Claude-first while default projects use **Codex Leaders + Claude Minions** | `README.md`, `.minions/settings.json` defaults | Medium | Docs lag the model-agnostic runtime |
| F6 | README architecture claims `scripts/` has a "permission setup" script — **it does not exist** | `README.md` §Architecture | Medium (trust) | Doc drift; no consent flow implemented |
| F7 | `npx tsx` / `npx vite` can hit the network / pick a wrong version on first run | `dev.mjs`, `server` script | Low–Med | Local deps invoked via `npx` instead of resolved bins |
| F8 | Windows detached process-group signalling differs; `--open` + strictPort assumptions | `start.mjs`, `dev.mjs` | Low–Med | Cross-platform paths untested/unlabelled |
| F9 | Codex auth failures only surface at first session start, not at preflight | `harness/codex/auth.ts` | Low | Lazy credential validation, no early signal |

---

## 3. Proposed public command model

Design principle: **the safest foreground localhost path is the default; remote
exposure and background service management are explicit opt-ins.** One verb =
one predictable behavior.

| Command | New semantics |
|---|---|
| `pnpm start` | **Foreground, localhost-only, full-stack.** Runs server + Vite, streams logs to the terminal, `Ctrl-C` stops. No Tailscale. This is the "just run it" command. (Rebinds today's `dev.mjs` as the default.) |
| `pnpm dev` | Alias of `pnpm start` (foreground full-stack) **or** removed. Kills F2 — `dev` must never be frontend-only. |
| `pnpm preflight` | Real prerequisite *tests*: Node≥22, pnpm, git, native build toolchain present, at least one harness resolvable **and** authenticated, ports free. Reports per-harness readiness; exits non-zero only on true blockers. |
| `pnpm serve` | **Opt-in background service** (today's detached `start.mjs` minus Tailscale). `pnpm serve stop/restart/status`. Localhost by default. |
| `pnpm serve --tailscale` | Background service **plus** tailnet HTTPS. The only path that touches Tailscale; requires explicit flag. Preserves current mobile/Web-Push behavior. |
| `pnpm build` / `pnpm preview` | Unchanged (built preview). |
| `pnpm serve:tailscale*` | Kept as lower-level plumbing, or folded under `pnpm serve --tailscale`. |

Migration note: this **replaces** the current `start`/`dev` semantics rather than
adding parallel ones (repo convention: replace, don't deprecate). Tailscale
functionality is preserved, just moved behind `serve --tailscale`.

---

## 4. Prerequisite matrix

Per harness and per OS. "Honest" = we label what we actually test and what is
unsupported.

### By harness

| Harness | Required to run a session | Auth discovery | Preflight should test |
|---|---|---|---|
| Claude Code | `claude` CLI installed + signed in, or `CLAUDE_CODE_PATH` | SDK discovery / `CLAUDE_CODE_PATH` | binary resolvable **and** `claude` responds to an auth check |
| OpenAI Codex | `codex login` **or** `CODEX_API_KEY`/`OPENAI_API_KEY`, or `CODEX_PATH` | env vars → `~/.codex/auth.json` | credentials present (env or auth.json) |
| (either) | At least **one** harness must be authenticated | — | ≥1 harness green, warn on the other |

Default new project = **Codex Leader + Claude Minion**, so onboarding should tell
users to authenticate **both** or change project defaults up front.

### By platform

| Prereq | macOS | Linux | Windows |
|---|---|---|---|
| Node ≥ 22 | ✅ | ✅ | ✅ |
| pnpm 10.15.1 | ✅ | ✅ | ✅ |
| git | ✅ | ✅ | ✅ |
| C++ toolchain for `better-sqlite3` | `xcode-select --install` | `build-essential` | MSVC Build Tools (**verify / label**) |
| Detached service signalling | ✅ | ✅ | ⚠️ process-group differs — label support level |
| Tailscale (optional) | ✅ | ✅ | ⚠️ verify |

Windows is currently **untested**; the plan labels it "experimental" rather than
claiming parity.

---

## 5. First-run journey (target)

1. **Clone → `pnpm install`** — README states the native-build prereq up front so
   the compile step isn't a surprise.
2. **`pnpm preflight`** — prints a per-harness readiness table with actionable
   fixes ("Codex: not authenticated → run `codex login`"). Green means the next
   command will actually work.
3. **`pnpm start`** — foreground, localhost, logs stream inline, opens
   `http://localhost:6173`. `Ctrl-C` stops. No network exposure.
4. **First-run UI** — create/open a project; a short panel explains: chosen
   harness/model, that Minions run in **git worktrees**, and that changes route
   through an **approval flow** before merging. Any action that would modify
   Claude/agent config or grant MCP/tool permissions requires **explicit consent**
   (no silent grants).
5. **Harmless first task** — a suggested starter Leader task (e.g. "summarize this
   repo's structure") so the user sees the loop end-to-end without risk.
6. **Where things live** — logs, `.minions/` per-project state, `~/.minions/`
   recent-projects index; how to reset without touching the user's repo.
7. **Opt into remote later** — "want it on your phone? `pnpm serve --tailscale`."

---

## 6. README / getting-started information architecture

Split the currently-mixed content into clearly separated modes:

1. **Run it locally (default)** — install, preflight, `pnpm start`. No Tailscale.
2. **Prerequisites** — harness matrix (Claude/Codex, authenticate both by default),
   platform matrix, native-build note.
3. **Background service** — `pnpm serve` + stop/restart/status.
4. **Remote / mobile (optional)** — `pnpm serve --tailscale`, Web-Push/HTTPS
   caveats, iOS notes. Explicitly tailnet-only, never funnel.
5. **Built preview** — `pnpm build && pnpm preview`.
6. **Troubleshooting / uninstall / data locations** — reset guidance that never
   deletes the user's repo.

Remove the false "permission setup" script reference (F6) or implement the script
it promises (see PR-D).

---

## 7. Staged implementation plan (PRs)

Each PR is independently shippable, has a disjoint write set, and carries its own
tests (repo rule: tests in the same commit).

| PR | Scope | Primary files (disjoint) | Tests |
|---|---|---|---|
| **PR-A** Command model | Rebind `start`=foreground full-stack localhost; add `serve` (background) + `serve --tailscale`; fix `dev`; drop Tailscale from default | `package.json`, `scripts/start.mjs`, `scripts/serve.mjs` (new from old start), `scripts/dev.mjs` | script-level unit tests for arg parsing / mode selection |
| **PR-B** Real preflight | Test Node/pnpm/git/toolchain/ports + per-harness auth; per-harness readiness table | `scripts/preflight.mjs` | unit tests for each check (mock env/exec) |
| **PR-C** README/docs IA | Restructure README into the 6 sections; correct Codex/Claude framing; fix F6 | `README.md`, this doc | doc-lint / link check |
| **PR-D** First-run UX + consent | First-run panel (harness/worktree/approval explainer), explicit consent before any config/permission change, starter task | `src/` first-run components + `server/` consent surface | component tests (`*.test.tsx`), contract test if new WS/MCP surface |
| **PR-E** Clean-clone smoke matrix | CI/manual smoke that boots from a fresh temp clone across modes | `tests/` + CI workflow | smoke matrix (below) |

Sequencing: PR-A and PR-B are the unblockers and can run in parallel (disjoint
files). PR-C depends on A/B naming. PR-D is the largest and independent. PR-E
lands last to lock behavior.

> **Gated surface note:** PR-D may touch approval-flow / worktree / bus surfaces
> that the system model gates (`server/worktree*.ts`, `server/commands/approve-*`,
> `server/ws-connection.ts`, etc.). Those tasks need a **work packet** before a
> minion edits them — `assign_task`/`plan_task` will flag this deterministically.

---

## 8. Clean-clone smoke-test matrix & acceptance criteria

Run from a **fresh temporary clone** (`git clone` into a tmp dir), no prior
`.run/`, `.minions/`, or global state.

| Scenario | Steps | Pass criteria |
|---|---|---|
| Cold install | `pnpm install` | better-sqlite3 builds; exit 0 |
| Preflight, no auth | `pnpm preflight` | reports which harness is unauthenticated; exit reflects blockers only |
| Foreground start | `pnpm start` | server + Vite up; `http://localhost:6173` serves; logs inline; **no Tailscale calls**; `Ctrl-C` stops both |
| `dev` is not frontend-only | `pnpm dev` | full stack (or errors telling user to use `start`) — never a broken Vite-only app |
| Background service | `pnpm serve` then `pnpm serve status/stop` | detached, localhost, status/stop accurate; no Tailscale |
| Remote opt-in | `pnpm serve --tailscale` (with Tailscale) | tailnet HTTPS as today; **skipped/labelled** when Tailscale absent, never blocks localhost |
| First session | create Leader, run starter task | session starts on an authenticated harness; worktree + approval explained |
| Reset | delete `.minions/` / `.run/` | app resets; user repo untouched |

Global acceptance: **a user with zero Tailscale can go clone → localhost session
without editing any script**, and remote exposure never happens without an
explicit flag.

---

## 9. Minion delegation map (disjoint ownership)

For when implementation is approved. Ownership boundaries prevent parallel-edit
conflicts (repo rule: isolated write sets).

| Minion | Owns (write set) | Must not touch |
|---|---|---|
| M1 — Commands | `package.json` scripts, `scripts/start.mjs`, `scripts/serve.mjs`, `scripts/dev.mjs` + their tests | `src/`, `README.md`, `server/` |
| M2 — Preflight | `scripts/preflight.mjs` + tests | command scripts, docs |
| M3 — Docs | `README.md`, `docs/onboarding-redesign.md` | all code |
| M4 — First-run UX (work packet) | `src/` first-run components, `server/` consent surface + tests | command scripts, docs |
| M5 — Smoke matrix | `tests/` smoke + CI workflow | product code |

M1/M2/M3 are fully disjoint → parallelizable immediately after approval. M4 is
serialized behind a work packet if it hits gated surfaces. M5 lands last.

---

## Open questions for the user

1. Scope: land the **whole** redesign, or start with PR-A + PR-B (command model +
   real preflight) as the highest-leverage unblockers?
2. `pnpm dev`: make it an alias of `start`, or remove it entirely?
3. Windows: commit to "experimental/labelled" now, or defer entirely?
4. First-run consent (PR-D): required in v1, or fast-follow?
