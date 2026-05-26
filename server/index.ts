/**
 * Server entrypoint — Express + WebSocket wiring.
 *
 * After Phase 5.2 this file is a thin dispatcher:
 *   - REST route mounting + auth
 *   - WebSocket server construction
 *   - SessionRegistry + Bus wiring
 *   - Command dispatch via `server/commands/`
 *   - Graceful shutdown
 *
 * Per-command logic lives in `server/commands/<name>.ts`. Per-session
 * lifecycle lives in `server/session-host.ts`.
 */

import express from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createProjectRoutes } from "./routes/projects.ts";
import { createFileRoutes } from "./routes/files.ts";
import { createBus } from "./bus.ts";
import { attachConnectionListeners } from "./ws-connection.ts";
import { cleanupStaleWorktrees } from "./worktree.ts";
import { listRecentProjects } from "./project-store.ts";
import type { SessionHostDeps, StartSessionOptions } from "./session-host.ts";
import { SessionRegistry } from "./session-registry.ts";
import { RoutineRunRegistry } from "./routine-registry.ts";
import { dispatchCommand } from "./commands/index.ts";
import type { CommandContext } from "./commands/index.ts";
import { WS_MAX_PAYLOAD_BYTES } from "./ws-config.ts";

// ── Auth Token ──────────────────────────────────────────
const AUTH_TOKEN = crypto.randomBytes(32).toString("hex");

// ── Database ─────────────────────────────────────────────
console.log("Server starting (per-project SQLite mode)");

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// ── CORS ────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Auth bootstrap endpoint (unauthenticated, localhost only) ──
app.get("/api/auth/token", (req: Request, res: Response) => {
  const host = req.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({ token: AUTH_TOKEN });
});

// ── Auth middleware ─────────────────────────────────────
function authMiddleware(req: Request, res: Response, next: Function) {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Mount REST API routes (with auth)
app.use("/api/projects", authMiddleware, createProjectRoutes());
app.use("/api/files", authMiddleware, createFileRoutes());

// ── HTTP + WebSocket Server ──────────────────────────────
const PORT = parseInt(process.env["PORT"] ?? "3141", 10);
const server = createServer(app);

// ── Origin validation ───────────────────────────────────
// Only allow WebSocket connections from localhost origins.
// This prevents drive-by attacks from malicious web pages.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
];

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

const wss = new WebSocketServer({
  server,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: (info: { origin: string; req: import("node:http").IncomingMessage }) => {
    const origin = info.origin ?? info.req.headers["origin"];
    if (!isAllowedOrigin(origin)) {
      console.warn(
        `[ws] Rejected connection from disallowed origin: ${origin}`,
      );
      return false;
    }
    const url = new URL(info.req.url ?? "", `http://${info.req.headers.host}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      console.warn(`[ws] Rejected connection: invalid auth token`);
      return false;
    }
    return true;
  },
});

// ── Session management ──────────────────────────────────

const MAX_SESSIONS = 50;

// ── Session registry + bus wiring ───────────────────────
//
// The in-memory Map that used to live here is now owned by SessionRegistry.
// SessionHost instances own their own lifecycle, the SDK query loop, and
// SQLite write-through — index.ts just dispatches WS commands against them.
//
// All outbound WebSocket traffic goes through `bus`. Direct broadcast calls
// outside `server/bus.ts` are forbidden by the `no-direct-broadcast`
// architecture fitness test.

const registry = new SessionRegistry();
const bus = createBus(wss);

const sessionDeps: SessionHostDeps = {
  bus,
  startChildSession: (opts: StartSessionOptions) => registry.start(opts),
  forEachLeaderTaskState: registry.forEachLeaderTaskState,
  getSessionRuntime: registry.getSessionRuntime,
  wakeWaitingLeaderIfAllChildrenTerminal:
    registry.wakeWaitingLeaderIfAllChildrenTerminal,
  terminateSession: (sessionKey, reason) =>
    registry.get(sessionKey)?.terminate(reason, {
      bus,
      forEachLeaderTaskState: registry.forEachLeaderTaskState,
      wakeWaitingLeaderIfAllChildrenTerminal:
        registry.wakeWaitingLeaderIfAllChildrenTerminal,
    }),
};
registry.setDeps(sessionDeps);

let keyCounter = 0;
function generateKey(): string {
  keyCounter += 1;
  return `session-${Date.now().toString(36)}-${keyCounter}`;
}

// ── Routine runtime ─────────────────────────────────────
//
// Owns live routine runs. Spawns its child Leaders through the same
// SessionRegistry as everything else, so a Routine-spawned Leader is
// indistinguishable from a hand-spawned one on the canvas — except that
// it also has a `report_phase_result` MCP tool wired in via step-tools.
const routines = new RoutineRunRegistry({ bus, sessionRegistry: registry });

// ── Command dispatcher context ──────────────────────────

const commandContext: CommandContext = {
  registry,
  bus,
  generateKey,
  maxSessions: MAX_SESSIONS,
  routines,
};

// ── WebSocket handlers ───────────────────────────────────

// Server-level errors (handshake failures, listener errors). Without this
// listener an emitted `'error'` would crash the Node process.
wss.on("error", (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[ws] Server error: ${msg}`);
});

wss.on("connection", (ws) => {
  attachConnectionListeners(ws, {
    snapshotSessions: () => registry.snapshot(),
    dispatch: (cmd, target) => dispatchCommand(commandContext, cmd, target),
  });
});

const HOST = process.env["HOST"] ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`Minions server on http://${HOST}:${PORT}`);
  console.log(`WebSocket available on ws://${HOST}:${PORT}`);
  console.log(`[auth] Auth token: ${AUTH_TOKEN.slice(0, 8)}...`);

  // Phase 4.4: rehydrate persisted sessions (tasks, render state) from SQLite
  registry.hydrateFromDb();

  // Clean up stale worktrees from previous sessions across all known projects
  const recentProjects = listRecentProjects();
  for (const project of recentProjects) {
    void cleanupStaleWorktrees(project.path).catch((err) => {
      console.warn(
        `Worktree cleanup skipped for ${project.path}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdownCleanup(): Promise<void> {
  console.log("[shutdown] Preserving active worktrees for session recovery.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdownCleanup());
process.on("SIGTERM", () => void shutdownCleanup());
