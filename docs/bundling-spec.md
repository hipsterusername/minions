# Bundling & Electron Packaging Spec

**Status:** implementation-ready (audited 2026-05-09)
**Scope:** ship Minions as a single-binary desktop app on macOS, Windows, and Linux,
without forcing users to clone, run `pnpm install`, or manage `claude`/`git`/Node
versions themselves.

## Executive summary

The repo is structurally close to packageable. The frontend already uses relative
`/api` paths and a single `ws://localhost:${port}` URL (`src/App.tsx:45`); the
backend already binds `127.0.0.1` with an auth-token + origin allowlist; SIGTERM
cleanup is wired (`server/index.ts:220`). The work is therefore additive:

1. **Bundle the server** to a self-contained `dist-server/server.cjs` so we stop
   shipping `tsx` + raw TypeScript.
2. **Have Express serve `dist/`** behind a `NODE_ENV=production` branch so the
   renderer and the API live on a single origin in the packaged app.
3. **Wrap with Electron**, forking the bundled server on a free port and
   `loadURL`-ing it.
4. **Rebuild `better-sqlite3`** against Electron's Node ABI and unpack its `.node`
   from the asar bundle.
5. **Repair PATH** (`fix-path`) so `claude` and `git` resolve when the GUI app is
   launched outside a shell.
6. **Build installers** with `electron-builder` (NSIS / DMG / AppImage) in CI.

Phases 1–2 are independently shippable and unblock Phase 3+. Code signing,
notarization, and auto-update are explicitly deferred to v1.

## Goals & non-goals

### Goals

- `pnpm verify` continues to pass, untouched.
- One additional command, `pnpm package`, produces signed-or-unsigned installers
  for the host OS.
- The packaged app boots without the user having `pnpm`, `tsx`, or a dev
  toolchain — only `claude` (one-time SDK auth) and `git`.
- Frontend code change is at most a single line (`WS_URL` source).
- Server code remains runnable standalone (`node dist-server/server.cjs`) for CI
  smoke tests and headless deployments.

### Non-goals (deferred)

- Apple notarization / Developer ID signing.
- Windows EV-cert signing.
- `electron-updater` auto-update channel.
- Bundling Node itself for non-Electron deployments.
- Packaging the `claude` CLI binary inside the app (evaluated, deferred to v1 —
  see §10).

## Current state — what we ship today

| Surface | Today |
|---|---|
| Frontend build | `tsc -b && vite build` → `dist/` (static) |
| Server runtime | `npx tsx server/index.ts` (TypeScript, unbundled) |
| Process orchestration | `scripts/dev.mjs` spawns `tsx server` + `vite --open` |
| Frontend ⇄ server bridge | Vite dev proxy (`/api → :3141`); WS to `ws://localhost:3141` |
| Native modules | `better-sqlite3` (rebuilt at install time per `pnpm.onlyBuiltDependencies`) |
| External binaries | Claude Code (SDK default discovery, optional `CLAUDE_CODE_PATH` env override); `git` (`server/worktree-exec.ts`) |
| Config dirs | `~/.minions/`, `<project>/.minions/`, `process.cwd()/data/canvas.db` fallback |
| Auth | Random 32-byte bearer token per process, served at `/api/auth/token`, localhost-only |

## Target topology

```
Electron main process
├── fix-path()                                     # macOS GUI PATH repair
├── const port = await getPort({ port: 3141 })     # prefer 3141, fall back to free
├── const child = fork('resources/app/dist-server/server.cjs', {
│     env: { ...process.env, PORT: port, NODE_ENV: 'production',
│            MINIONS_DATA_DIR: app.getPath('userData') }
│   })
│   └── Express on 127.0.0.1:${port}
│         ├── /api/*          (existing handlers, unchanged)
│         ├── /ws             (existing WebSocket, unchanged)
│         └── express.static(distDir)              # NEW
│               └── falls back to index.html for SPA routes
│   └── better-sqlite3 (.node from app.asar.unpacked)
│   └── spawns Claude Code through the SDK and `git` via inherited env/PATH
└── BrowserWindow.loadURL(`http://127.0.0.1:${port}`)
      └── React renderer — relative `/api` and ws://localhost just work
            ↑
            └── preload.ts: contextBridge.exposeInMainWorld('minions', { serverUrl })
```

The renderer never reaches outside `127.0.0.1:${port}`. CSP can therefore be
strict (see §8).

## Phase 1 — Server bundling (no Electron yet)

### 1.1 Add `pnpm build:server`

New script:

```jsonc
"build:server": "node scripts/build-server.mjs"
```

`scripts/build-server.mjs` invokes esbuild programmatically:

```js
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist-server/server.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  minify: false,
  external: [
    "better-sqlite3",            // native — load from node_modules at runtime
    "@anthropic-ai/claude-agent-sdk", // ESM + dynamic claude bin path; safer external
    "fsevents",                   // optional darwin-only native
  ],
  banner: {
    // esbuild emits CJS; the SDK is ESM-only and uses dynamic import internally,
    // which CJS supports. No banner shim needed today.
  },
  logLevel: "info",
});
```

**Why CJS:** `better-sqlite3` and most Electron tooling assume CJS for native
addons. We can revisit ESM once `--experimental-require-module` lands stably.

**Why externalize the SDK:** it embeds dynamic `import()` of the Claude bin and
ships its own native bits; bundling tends to break path resolution. Externals
ship via `node_modules` in the asar.

### 1.2 Express serves `dist/` in production

In `server/index.ts`, after auth middleware mounts and before the 404, add:

```ts
if (process.env.NODE_ENV === "production") {
  const distDir = path.resolve(__dirname, "../dist");
  app.use(express.static(distDir, { index: "index.html" }));
  app.get(/^(?!\/api\/).*$/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}
```

The regex preserves `/api/*` 404 behaviour and lets the SPA handle every other
route (currently there are none, but it future-proofs).

**File-size budget:** `server/index.ts` is at 245 / 400 lines today. The static
block is ≤ 8 lines. If it pushes us past budget, extract to
`server/static-host.ts` (test: `tests/architecture/file-size.test.ts`).

### 1.3 Data directory override

Today `server/db.ts` uses `process.cwd()/data/canvas.db` as a fallback. In a
packaged app `process.cwd()` is meaningless. Add a single env override:

```ts
const DEFAULT_DB_PATH = process.env.MINIONS_DATA_DIR
  ? path.join(process.env.MINIONS_DATA_DIR, "canvas.db")
  : path.join(process.cwd(), "data", "canvas.db");
```

Same treatment for `server/project-store.ts`'s `~/.minions/` constant if we
decide to redirect global state into Electron's `userData` (recommended — keeps
uninstall clean).

### 1.4 Acceptance — Phase 1

- `pnpm build && pnpm build:server` produces `dist/` and `dist-server/server.cjs`.
- `NODE_ENV=production node dist-server/server.cjs` boots, `curl http://127.0.0.1:3141/api/auth/token` returns a token, and `curl http://127.0.0.1:3141/` returns `dist/index.html`.
- The standalone server passes the existing test suite via `pnpm test:run` (no test changes expected — Phase 1 is additive).
- New file-size assertion holds.
- New colocated test: `server/static-host.test.ts` (or inline in
  `server/index.test.ts` if we keep the block in `index.ts`) covers the SPA
  fallback regex.

## Phase 2 — Electron shell

### 2.1 Dependency additions

`devDependencies`:

```jsonc
"electron": "^32.0.0",
"electron-builder": "^25.0.0",
"@electron/rebuild": "^3.7.0"
```

`dependencies`:

```jsonc
"fix-path": "^4.0.0",
"get-port": "^7.1.0"
```

Pin exact versions per global standard (`==`, no `^/~`) — these are devDeps so the
caret is per the existing devDep convention; flip to exact at the first sign of
churn.

### 2.2 New tree

```
electron/
  main.ts          # app lifecycle, server fork, BrowserWindow
  preload.ts       # contextBridge: minions.serverUrl, minions.appVersion
  ipc.ts           # main↔renderer messages (settings, quit reasons)
  build-main.mjs   # esbuild bundle for main+preload (CJS, target: node22)
```

`electron-builder` config lives at the repo root in `electron-builder.yml`
(YAML chosen — multi-line config & comments).

### 2.3 `electron/main.ts` skeleton

Responsibilities, in order:

1. `fixPath()` — must run before any child spawn.
2. `app.requestSingleInstanceLock()` — second launches focus the window.
3. `await getPort({ port: 3141 })` — preferred port, fall back automatically.
4. `fork('dist-server/server.cjs', { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`.
5. Wait for `'listening'` IPC message OR a connectivity poll on `/api/auth/token` with a 5s timeout.
6. `createWindow()` → `loadURL(http://127.0.0.1:${port})`.
7. Forward server `stderr` into Electron's logger.
8. On `before-quit`: `child.kill('SIGTERM')`; await `'exit'` up to 5s; `app.exit()`.
9. On `child.exit` outside shutdown: surface dialog, then quit.

To make step 5 reliable, add an IPC notify in the bundled server:

```ts
// server/index.ts, inside server.listen callback
if (process.send) process.send({ type: "listening", port: PORT });
```

This is a 2-line, env-agnostic addition — `process.send` is undefined when not
forked, so it's a no-op in dev.

### 2.4 `electron/preload.ts`

```ts
import { contextBridge } from "electron";

const url = process.env.MINIONS_SERVER_URL ?? "";
contextBridge.exposeInMainWorld("minions", {
  serverUrl: url,
  appVersion: process.env.MINIONS_APP_VERSION ?? "",
});
```

`MINIONS_SERVER_URL` is set on the BrowserWindow via `additionalArguments` or
through `webPreferences.additionalArguments` then read in preload via
`process.argv` — the env-var route is simplest.

### 2.5 Renderer change — single line

In `src/App.tsx:45`:

```ts
const WS_URL =
  (typeof window !== "undefined" && (window as any).minions?.serverUrl)
    ? `${(window as any).minions.serverUrl.replace(/^http/, "ws")}`
    : `ws://localhost:${import.meta.env["VITE_SERVER_PORT"] ?? "3141"}`;
```

Replace the `(window as any)` cast with a proper `src/window-minions.d.ts` global
type declaration (5 lines). Test: existing `src/use-socket.test.tsx` already
exercises `WS_URL` — extend it with a case where `window.minions.serverUrl` is
populated.

### 2.6 Acceptance — Phase 2

- `pnpm electron:dev` (new script: `concurrently pnpm dev + electron .`) launches the dev app pointing at the Vite server.
- `pnpm electron:start` (after `pnpm build && pnpm build:server`) launches against the bundled server.
- Quitting via Cmd-Q runs the SIGTERM cleanup path in `server/index.ts:220`; `worktree list` shows no leaked entries.
- New test: `electron/main.test.ts` unit-tests the port-selection + fork-and-wait helpers (mock `child_process.fork`, assert it's called with the expected env and that the listening IPC resolves the promise).

## Phase 3 — Native modules

### 3.1 `better-sqlite3` rebuild

Add a postinstall hook that runs only when Electron is present:

```jsonc
"scripts": {
  "postinstall": "node scripts/maybe-rebuild-electron.mjs"
}
```

`scripts/maybe-rebuild-electron.mjs` checks `node_modules/electron/package.json`
exists, then calls `@electron/rebuild` programmatically against
`better-sqlite3`. Skipping when Electron is absent keeps `pnpm install` fast for
contributors who don't care about packaging.

### 3.2 `electron-builder` asar config

```yaml
asar: true
asarUnpack:
  - "node_modules/better-sqlite3/build/Release/*.node"
  - "node_modules/better-sqlite3/lib/binding/**"
files:
  - "dist/**"
  - "dist-server/**"
  - "node_modules/better-sqlite3/**"
  - "node_modules/@anthropic-ai/claude-agent-sdk/**"
  - "node_modules/bindings/**"
  - "node_modules/file-uri-to-path/**"
  - "package.json"
```

Verify the dependency closure with `npx ls-deps better-sqlite3` (or `pnpm why`)
before locking the `files` list — under-listing is the most common cause of
"module not found" in packaged Electron apps.

### 3.3 Acceptance — Phase 3

- Packaged app boots and writes a row to SQLite — verified by a one-shot smoke
  test that creates a project then reads it back.
- `electron-builder --dir` output contains `app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`.

## Phase 4 — Installers

### 4.1 `electron-builder.yml`

```yaml
appId: com.anthropic.minions
productName: Minions
copyright: © Anthropic PBC
directories:
  output: release
  buildResources: build
files: [ ... see §3.2 ]
asarUnpack: [ ... see §3.2 ]

mac:
  category: public.app-category.developer-tools
  target:
    - { target: dmg, arch: [arm64, x64] }
  hardenedRuntime: true
  gatekeeperAssess: false   # set true once we have signing
  identity: null            # set once we have a Developer ID

win:
  target:
    - { target: nsis, arch: [x64] }
  signAndEditExecutable: false   # flip on once we have a cert

linux:
  target:
    - { target: AppImage, arch: [x64] }
    - { target: deb, arch: [x64] }
  category: Development

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

### 4.2 CI matrix

`.github/workflows/package.yml` (separate from the existing `ci.yml` which gates
`pnpm verify`):

| Job | Runner | Output |
|---|---|---|
| `package-mac` | `macos-14` (arm64) | `Minions-${ver}-arm64.dmg`, `Minions-${ver}-x64.dmg` |
| `package-win` | `windows-2022` | `Minions Setup ${ver}.exe` |
| `package-linux` | `ubuntu-22.04` | `Minions-${ver}.AppImage`, `minions_${ver}_amd64.deb` |

Trigger: `workflow_dispatch` and `release: published`. Artefacts upload to the
release.

### 4.3 Acceptance — Phase 4

- A tagged release produces three artefacts; each launches successfully on a
  clean VM and reaches the projects screen.
- README "Install" section links to the latest release; "Quick Start" remains as
  the developer path.

## Phase 5 — Deferred

Listed for tracking; explicitly out of scope for this spec.

- **Apple Developer ID signing + notarytool** (requires team membership +
  notarization round-trip in CI).
- **Windows OV/EV signing** (cert procurement, HSM in CI).
- **`electron-updater`** wired to GitHub releases.
- **Custom protocol handler** (`minions://...`) for deep links.
- **App menu / About dialog** beyond defaults.

## §8. Cross-cutting concerns

### 8.1 Content Security Policy

Once Electron loads from `http://127.0.0.1:${port}`, set a strict CSP via meta
tag in `index.html`:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*;
               style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
               font-src 'self' https://fonts.gstatic.com;
               img-src 'self' data: blob:;
               script-src 'self'">
```

The Google Fonts `<link>` in `index.html` is the only outbound request today.
Self-hosting via `@fontsource/*` is preferable long-term but not blocking — drop
when convenient.

### 8.2 PATH semantics

`fix-path` runs at main-process startup. The forked server inherits the
augmented PATH via `process.env`, which remains important for `git` and any
user-provided executable overrides. The Claude harness does not probe PATH
itself: it passes `CLAUDE_CODE_PATH` only when the environment sets it, and
otherwise lets the Claude Agent SDK perform its platform-aware default
discovery.

For Linux distributions where `fix-path` is a no-op, the desktop launcher
inherits the user session PATH — which is correct.

### 8.3 Single instance & deep links

`app.requestSingleInstanceLock()` plus `second-instance` event handler that
calls `mainWindow.focus()`. Deep links (Phase 5) plug into the same handler.

### 8.4 Logging

Server `stdout`/`stderr` is forwarded to Electron's logger, which writes to
`app.getPath('logs')`. Add a "Show Logs" tray-menu entry in v1.

### 8.5 Uninstall hygiene

Routing `~/.minions/` and the `data/canvas.db` fallback through
`app.getPath('userData')` means uninstallers can purge state cleanly without
needing per-OS cleanup scripts. The per-project `<project>/.minions/` sidecar
remains where it is — that's user content, not app state.

## §9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `better-sqlite3` fails to load in packaged build | Medium | Blocks Phase 3 | Smoke-test in CI on every Electron version bump; pin Electron + `@electron/rebuild` versions |
| User needs a non-default Claude Code executable | Medium | App may use the wrong executable | Surface a settings UI that sets `CLAUDE_CODE_PATH`; the harness passes only that env override and otherwise delegates discovery to the SDK |
| pnpm hoisting layout breaks `electron-builder` `files` resolution | Medium | Build fails | Use `pnpm install --shamefully-hoist` in the package CI job, OR set `node-linker=hoisted` for the package step only |
| Server child outlives main process on hard kill | Low | Orphan worktrees | `cleanupStaleWorktrees()` already runs at next boot (`server/index.ts:208`) |
| Bundle size > 200 MB (Electron baseline ≈ 90 MB; SDK + node_modules adds 50–80 MB) | Medium | Slow installer | Strip dev locales (`electron-builder` `electronLanguages: ['en-US']`); audit `files` allowlist |
| macOS Gatekeeper blocks unsigned v0 build | Certain | Friction | Document `xattr -dr com.apple.quarantine` workaround; signal "early build" in README; do not publish to Mac App Store |

## §10. Bundling `claude` — evaluation

We considered shipping `@anthropic-ai/claude-code` inside the app and pointing
`CLAUDE_CODE_PATH` at its `cli.js`. **Deferred** because:

- The user still has to run `claude` once for OAuth/login, and that login is
  per-binary on disk — bundling means a second login.
- It nearly doubles install size.
- It locks our release cadence to the upstream CLI's.

Revisit when (a) `claude-agent-sdk` exposes a programmatic auth flow that
doesn't require the CLI binary at all, or (b) we hit a measured friction floor
from users not having `claude` installed.

## §11. Acceptance — overall

The spec is satisfied when all of the following are true:

1. `pnpm verify` is unchanged and green.
2. `pnpm build:server && node dist-server/server.cjs` boots a working server.
3. `pnpm electron:start` opens a functional Minions window with no Vite running.
4. `pnpm package` produces an installer for the host OS that, when launched on a
   clean machine with `claude` and `git` installed, reaches the projects screen
   and creates a project successfully.
5. Worktrees created in the packaged app are cleaned up on quit.
6. The architecture-fitness suite still passes (no oversized server files; no
   cross-tree imports; broadcasts only via `bus.ts`).

## §12. Out-of-scope explicitly

- Replacing `tsx` in dev — `pnpm server` and `pnpm start` continue to use it.
- Replacing `pnpm` with `npm` or `bun` for any reason.
- Web-hosted / SaaS deployment of Minions.
- Mobile (iPad/iOS/Android) packaging.
- Sandbox / Mac App Store distribution.

## §13. Files this spec will create or modify

**Create**

- `scripts/build-server.mjs`
- `scripts/maybe-rebuild-electron.mjs`
- `electron/main.ts`
- `electron/preload.ts`
- `electron/ipc.ts`
- `electron/build-main.mjs`
- `electron-builder.yml`
- `src/window-minions.d.ts`
- `.github/workflows/package.yml`
- `docs/bundling-spec.md` (this file)

**Modify**

- `package.json` — add `build:server`, `electron:dev`, `electron:start`,
  `package`, `postinstall`, plus the dep entries in §2.1.
- `server/index.ts` — static hosting block (§1.2), `process.send('listening')`
  (§2.3).
- `server/db.ts` — `MINIONS_DATA_DIR` resolution (§1.3).
- `server/project-store.ts` — same env override for `~/.minions/`.
- `src/App.tsx` — single-line `WS_URL` source (§2.5).
- `index.html` — strict CSP meta (§8.1).
- `tests/architecture/file-size.test.ts` — confirm new server file (if any) is
  under budget; no edit needed if §1.2 stays inline.

Net add ≈ 12 files, ~600 LOC, plus generously-tested helpers in `electron/`.
