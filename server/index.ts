/**
 * Server entrypoint — Express + WebSocket wiring.
 *
 * This file is a thin dispatcher:
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
import { resolveWorkItemProject } from "./work-item-project.ts";
import { sweepOrphanHtmlArtifacts } from "./html-artifact-store.ts";
import type { SessionHostDeps, StartSessionOptions } from "./session-host.ts";
import { SessionRegistry } from "./session-registry.ts";
import { dispatchCommand } from "./commands/index.ts";
import type { CommandContext } from "./commands/index.ts";
import { WS_MAX_PAYLOAD_BYTES } from "./ws-config.ts";
import { isAllowedAuthBootstrapRequest, isAllowedOrigin } from "./network-access.ts";
import { openPersistDb } from "./session-persist.ts";
import { loadOrCreateVapidKeys } from "./push-vapid.ts";
import { createPushStore } from "./push-store.ts";
import { createPushRoutes } from "./routes/push.ts";
import { createPushNotifier } from "./push-notifier.ts";
import { sendWebPush } from "./push-sender.ts";
import { serverLogger } from "./logging.ts";
import { createReadinessRoutes } from "./routes/readiness.ts";
import { getHarnessReadiness } from "./harness/readiness.ts";
import "./harness/register-production.ts";
import { launchSession } from "./session-launch.ts";
import { bootstrapWorkItemRuntime } from "./work-item-bootstrap.ts";
import { installLiveEditWorkItemBridges } from "./live-edit-work-item-runtime.ts";
import { snapshotLiveEditAwareness } from "./live-edit-runtime.ts";
import { ensureWorktreeIntegrationSchema } from "./worktree-integration-schema.ts";
import { SqliteWorktreeIntegrationService } from "./worktree-integration-sqlite.ts";
import { createSqliteGitIntegrationStore } from "./sqlite-git-integration-store.ts";
import { createProductionGitIntegrationWorker } from "./git-integration-worker.ts";
import { createGitIntegrationPump } from "./git-integration-pump.ts";
import { getLineageState, getQueueEntry, recordLineageGate,
  recoverInterruptedIntegrations } from "./worktree-integration-repo.ts";
import { emitItemChanged } from "./work-item-service-events.ts";

const log = serverLogger.child("main");

const AUTH_TOKEN = crypto.randomBytes(32).toString("hex");

log.info("starting", { persistence: "per-project-sqlite" });

const app = express();
app.use(express.json({ limit: "10mb" }));

// Baseline browser hardening. A restrictive CSP is intentionally omitted here:
// the Vite development client needs dynamic scripts and WebSocket connections.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
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

app.get("/api/auth/token", (req: Request, res: Response) => {
  const origin = req.headers.origin;
  if (!isAllowedAuthBootstrapRequest({
    hostname: req.hostname,
    remoteAddress: req.socket.remoteAddress,
    origin: Array.isArray(origin) ? origin[0] : origin,
  })) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({ token: AUTH_TOKEN });
});

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
app.use("/api/readiness", authMiddleware, createReadinessRoutes());
app.post("/api/server/restart", authMiddleware, (_req: Request, res: Response) => {
  res.json({ ok: true, restarting: true });
  setTimeout(() => {
    log.info("restart_requested", { source: "settings" });
    process.exit(42);
  }, 100).unref();
});

// Server-authoritative subscriptions + VAPID keys live in the shared
// server.db. Registration is over HTTP (behind auth); the notifier reads
// the bus and fans approval/minion/error events out as Web Push.
const pushDb = openPersistDb();
const vapidKeys = loadOrCreateVapidKeys(pushDb);
const pushStore = createPushStore(pushDb);
app.use("/api/push", authMiddleware, createPushRoutes({ store: pushStore, vapid: vapidKeys }));

const PORT = parseInt(process.env["PORT"] ?? "3141", 10);
const server = createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: (info: { origin: string; req: import("node:http").IncomingMessage }) => {
    const origin = info.origin ?? info.req.headers["origin"];
    if (!isAllowedOrigin(origin)) {
      log.warn("ws_connection_rejected", { cause: "origin", origin });
      return false;
    }
    const url = new URL(info.req.url ?? "", `http://${info.req.headers.host}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      log.warn("ws_connection_rejected", { cause: "auth" });
      return false;
    }
    return true;
  },
});

const MAX_SESSIONS = 50;

//
// SessionHost instances own their own lifecycle, the SDK query loop, and
// SQLite write-through — index.ts just dispatches WS commands against them.
//
// All outbound WebSocket traffic goes through `bus`. Direct broadcast calls
// outside `server/bus.ts` are forbidden by the `no-direct-broadcast`
// architecture fitness test.

const registry = new SessionRegistry();
const bus = createBus(wss);

// Fan approval/minion/error bus events out as Web Push notifications.
createPushNotifier({ bus, store: pushStore, vapid: vapidKeys, send: sendWebPush });

const sessionDeps: SessionHostDeps = {
  bus,
  startChildSession: (opts: StartSessionOptions) => launchSession({ registry, bus, options: opts, executorClass: opts.executorClass }).catch((error) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "SESSION_LAUNCH_FAILED";
    bus.emitToSession(opts.sessionKey, { type: "session_error", sessionKey: opts.sessionKey, code, error: error instanceof Error ? error.message : "Session launch failed", timestamp: Date.now() });
    throw error;
  }),
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
      workItemLifecycle: sessionDeps.workItemLifecycle,
    }),
};
// Canonical migration/recovery must finish before registry hydration reads
// compatibility session rows. Runtime lifecycle hooks attach through the
// bootstrap seam separately; command mutations are available immediately.
ensureWorktreeIntegrationSchema(pushDb);
const worktreeIntegrations = new SqliteWorktreeIntegrationService(pushDb, Date.now,
  undefined, undefined, bus);
const gitIntegrationWorker = createProductionGitIntegrationWorker(createSqliteGitIntegrationStore(
  pushDb, Date.now, (lineageId) => worktreeIntegrations.refresh(lineageId)), {
  evaluateGate: async ({ operation }) => {
    if (!operation.lineageId) return { allowed: false, reason: "lineage identity required" };
    const state = getLineageState(pushDb, operation.lineageId);
    const failed = (state.gates as Array<{ scope: string; status: string; name: string }>)
      .find((gate) => gate.scope === "lineage" && gate.name !== "promotion_runtime"
        && !["passed", "waived"].includes(gate.status));
    return failed ? { allowed: false, reason: `lineage gate ${failed.name} is ${failed.status}` }
      : { allowed: true };
  },
  onGateEvaluated: async ({ operation }, verdict) => {
    if (!operation.lineageId) return;
    recordLineageGate(pushDb, { id: `promotion-gate:${operation.lineageId}`,
      lineageId: operation.lineageId, name: "promotion_runtime",
      status: verdict.allowed ? "passed" : "failed", details: verdict.reason,
      at: Date.now() });
  },
  onDurableTransition: ({ phase, operation, result }) => {
    const payload = { type: "worktree_integration_transition", phase,
      queueId: operation.id, lineageId: operation.lineageId ?? null,
      contributionId: operation.contributionId ?? null, result, timestamp: Date.now() };
    if (operation.workItemId) bus.emitToWorkItem?.(operation.workItemId, payload);
    else if (operation.projectId) bus.emitToProject(operation.projectId, payload);
  },
});
const gitIntegrationPump = createGitIntegrationPump(gitIntegrationWorker, {
  onError: (error, repositoryPath, targetRef) =>
    log.warn("git_integration_worker_failed", { repositoryPath, targetRef, error }),
});
const drainIntegrationScope = gitIntegrationPump.notify;
worktreeIntegrations.setQueueNotifier(drainIntegrationScope);
for (const queueId of recoverInterruptedIntegrations(pushDb, Date.now())) {
  const entry = getQueueEntry(pushDb, queueId); if (entry) drainIntegrationScope(entry.repository_path, entry.target_ref);
}
for (const scope of pushDb.prepare(`SELECT DISTINCT repository_path,target_ref
  FROM worktree_integration_queue WHERE state='queued'`).all() as
  Array<{ repository_path: string; target_ref: string }>) {
  drainIntegrationScope(scope.repository_path, scope.target_ref);
}
const { workItems, runtimeLifecycle, continueRun, registerChildAllocationCallback } = bootstrapWorkItemRuntime({
  db: pushDb,
  bus,
  registry,
  bindWorktreeRun: (input) => worktreeIntegrations.bindRun(input),
  collectWorktreeRun: (runKey, outcome) => worktreeIntegrations.collectRun(runKey, outcome),
});
worktreeIntegrations.setWorkItemNotifier((workItemId, cause) => {
  const detail = workItems.getSync(workItemId); if (detail) emitItemChanged(bus, detail,
    `worktree_${cause}`, Date.now());
});
void worktreeIntegrations.recoverTerminalContributions()
  .catch((error) => log.warn("terminal_contribution_recovery_failed", { error }));
sessionDeps.workItemLifecycle = runtimeLifecycle;
sessionDeps.transitionWorktreeProvisioning = (runKey, outcome, error) =>
  worktreeIntegrations.transitionProvisioning(runKey, outcome, error);
const liveEditWorkItems = installLiveEditWorkItemBridges({ db: pushDb, bus, service: workItems });
sessionDeps.cleanupLiveEditRun = liveEditWorkItems.disconnectRun;
sessionDeps.startWorkItemChildRun = async (input) => {
  const unregister = input.onAllocated
    ? registerChildAllocationCallback(input.requestId, input.onAllocated) : () => {};
  let run;
  try { run = await workItems.startChildRun(input); } finally { unregister(); }
  const host = registry.get(run.runKey);
  if (!host) throw new Error(`Allocated child run ${run.runKey} did not launch`);
  return { sessionKey: run.runKey, harness: host.harnessName,
    model: host.model ?? input.model ?? "",
    permissionMode: host.permissionMode ?? input.permissionMode ?? "auto" };
};
sessionDeps.resumeWorkItemRun = async (input) => { await workItems.resumePrimaryRun(input); };
sessionDeps.continueWorkItemChild = async (input) => { await workItems.continueChildRun(input); };
registry.setDeps(sessionDeps);

let keyCounter = 0;
function generateKey(): string {
  keyCounter += 1;
  return `session-${Date.now().toString(36)}-${keyCounter}`;
}

const commandContext: CommandContext = {
  registry,
  bus,
  generateKey,
  getLiveEditAwareness: snapshotLiveEditAwareness,
  maxSessions: MAX_SESSIONS,
  launchSession: (options) => launchSession({ registry, bus, options }),
  workItems,
  worktreeIntegrations,
  resolveWorkItemProject,
};

// Server-level errors (handshake failures, listener errors). Without this
// listener an emitted `'error'` would crash the Node process.
wss.on("error", (err: unknown) => {
  log.error("ws_server_error", { error: err });
});

wss.on("connection", (ws) => {
  attachConnectionListeners(ws, {
    snapshotSessions: () => registry.snapshot(),
    dispatch: (cmd, target) => dispatchCommand(commandContext, cmd, target),
  });
});

const HOST = process.env["HOST"] ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  log.info("listening", { host: HOST, port: PORT, websocket: true });
  void getHarnessReadiness().catch((error) => log.warn("readiness_warm_failed", { error }));

  registry.hydrateFromDb();

  // Sweep temporary HTML artifacts whose session no longer exists (a session
  // that died without its remove/clear cleanup running). Session-scoped dirs
  // for still-known sessions are preserved.
  const knownSessionKeys = registry.snapshot().map((s) => s.sessionKey);
  void sweepOrphanHtmlArtifacts(knownSessionKeys)
    .then((removed) => {
      if (removed > 0) {
        log.info("artifact_sweep_completed", { removed });
      }
    })
    .catch((err) => {
      log.warn("artifact_sweep_skipped", { error: err });
    });

  // Clean up stale worktrees from previous sessions across all known projects
  const recentProjects = listRecentProjects();
  for (const project of recentProjects) {
    void cleanupStaleWorktrees(project.path).catch((err) => {
      log.warn("worktree_cleanup_skipped", {
        projectPath: project.path,
        error: err,
      });
    });
  }
});

async function shutdownCleanup(): Promise<void> {
  log.info("shutdown_requested", { worktrees: "preserved" });
  gitIntegrationPump.shutdown();
  liveEditWorkItems.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdownCleanup());
process.on("SIGTERM", () => void shutdownCleanup());
