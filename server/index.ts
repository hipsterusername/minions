import express from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createProjectRoutes } from "./routes/projects.ts";
import { createFileRoutes } from "./routes/files.ts";
import { createBus, unicastToSession, unicastGlobal } from "./bus.ts";
import {
  createWorktree,
  removeWorktree,
  mergeAndCleanup,
  getDetailedDiff,
  cleanupStaleWorktrees,
} from "./worktree.ts";
import { validateSessionCwd } from "./path-guard.ts";
import { listRecentProjects } from "./project-store.ts";
import { removePersistedSession } from "./session-persist.ts";
import {
  SessionHost,
  isValidThinkingConfig,
  type BufferedEvent,
  type SessionHostDeps,
  type SessionRole,
  type StartSessionOptions,
  type ThinkingConfig,
} from "./session-host.ts";
import { SessionRegistry } from "./session-registry.ts";

// ── Auth Token ──────────────────────────────────────────
const AUTH_TOKEN = crypto.randomBytes(32).toString("hex");

// ── Database ─────────────────────────────────────────────
console.log("Server starting (per-project SQLite mode)");

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// ── CORS ────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowedOrigins = ["http://localhost:5173", "http://localhost:4173", "http://127.0.0.1:5173"];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  // Allow connections with no origin header (non-browser clients like CLI tools)
  if (!origin) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

const wss = new WebSocketServer({
  server,
  maxPayload: 1 * 1024 * 1024, // 1MB max message size
  verifyClient: (info) => {
    const origin = info.origin ?? info.req.headers["origin"];
    if (!isAllowedOrigin(origin)) {
      console.warn(`[ws] Rejected connection from disallowed origin: ${origin}`);
      return false;
    }
    // Check auth token in query string
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

// ── WebSocket command types ─────────────────────────────

type WsCommandType =
  // Session lifecycle
  | "create_session"
  | "send_message"
  | "stop_session"
  | "sync_session"
  | "list_sessions"
  // Execution control
  | "interrupt"
  | "interrupt_session"
  | "close_session"
  // Configuration control
  | "set_permission_mode"
  | "set_model"
  // Task control
  | "stop_task"
  // Worktree control
  | "merge_worktree"
  | "discard_worktree"
  | "get_worktree_diff"
  | "approve_changes"
  | "force_merge"
  | "theirs_merge"
  | "retry_merge"
  | "remove_session"
  // File & state control
  | "rewind_files"
  | "seed_read_state"
  // Info queries
  | "get_context_usage"
  | "get_supported_models"
  | "get_supported_commands"
  | "get_supported_agents"
  | "get_account_info"
  | "get_mcp_server_status"
  // MCP server control
  | "reconnect_mcp_server"
  | "toggle_mcp_server";

interface WsCommand {
  type: WsCommandType;
  sessionKey?: string;
  prompt?: string;
  cwd?: string;
  permissionMode?: string;
  systemPrompt?: string;
  role?: SessionRole;
  worktreeIsolation?: boolean;
  // Configuration params
  model?: string;
  /** Adaptive-thinking config — may be updated on every send_message */
  thinkingConfig?: unknown;
  projectPath?: string;
  // Task control params
  taskId?: string;
  // Rewind params
  userMessageId?: string;
  dryRun?: boolean;
  // Seed read state params
  path?: string;
  mtime?: number;
  // MCP server params
  serverName?: string;
  enabled?: boolean;
  // Request ID for correlating async responses
  requestId?: string;
}

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
};
registry.setDeps(sessionDeps);

let keyCounter = 0;
function generateKey(): string {
  keyCounter += 1;
  return `session-${Date.now().toString(36)}-${keyCounter}`;
}

/** Helper: get session or send error, returns null on failure */
function getSessionOrError(
  sessionKey: string | undefined,
  ws: WebSocket,
): SessionHost | null {
  if (!sessionKey) {
    unicastGlobal(ws, { type: "error", message: "sessionKey required" });
    return null;
  }
  const session = registry.get(sessionKey);
  if (!session) {
    unicastToSession(ws, sessionKey, {
      type: "error",
      message: `Session ${sessionKey} not found`,
    });
    return null;
  }
  return session;
}

/** Helper: send a control_response back to the requesting client */
function sendControlResponse(
  ws: WebSocket,
  command: string,
  sessionKey: string,
  requestId: string | undefined,
  data?: Record<string, unknown>,
): void {
  unicastToSession(ws, sessionKey, {
    type: "control_response",
    command,
    sessionKey,
    requestId: requestId ?? null,
    success: true,
    ...data,
  });
}

/** Helper: send a control_error back to the requesting client */
function sendControlError(
  ws: WebSocket,
  command: string,
  sessionKey: string,
  requestId: string | undefined,
  error: string,
): void {
  unicastToSession(ws, sessionKey, {
    type: "control_response",
    command,
    sessionKey,
    requestId: requestId ?? null,
    success: false,
    error,
  });
}


// ── Command handler ─────────────────────────────────────

function handleCommand(cmd: WsCommand, ws: WebSocket): void {
  switch (cmd.type) {
    // ────────────────────────────────────────────────────
    // Session lifecycle
    // ────────────────────────────────────────────────────

    case "create_session": {
      if (registry.size >= MAX_SESSIONS) {
        unicastGlobal(ws, {
          type: "error",
          message: `Maximum session limit (${MAX_SESSIONS}) reached. Remove unused sessions first.`,
        });
        return;
      }
      const key = cmd.sessionKey ?? generateKey();
      const rawCwd = cmd.cwd ?? process.cwd();
      const cwd = validateSessionCwd(rawCwd);
      if (!cwd) {
        unicastGlobal(ws, { type: "error", message: "Invalid cwd: must be under home directory" });
        return;
      }
      const prompt = cmd.prompt ?? "Hello";
      const initialThinking: ThinkingConfig | null = isValidThinkingConfig(cmd.thinkingConfig)
        ? cmd.thinkingConfig
        : null;
      registry.start({
        sessionKey: key,
        prompt,
        cwd,
        systemPrompt: cmd.systemPrompt,
        role: cmd.role,
        worktreeIsolation: cmd.worktreeIsolation,
        initialModel: cmd.model ?? null,
        thinkingConfig: initialThinking,
      });
      unicastToSession(ws, key, {
        type: "session_created",
        sessionKey: key,
      });
      break;
    }

    case "send_message": {
      if (!cmd.sessionKey || !cmd.prompt) {
        unicastGlobal(ws, {
          type: "error",
          message: "sessionKey and prompt required",
        });
        return;
      }
      const sendSession = registry.get(cmd.sessionKey);
      if (!sendSession) {
        unicastToSession(ws, cmd.sessionKey, {
          type: "error",
          message: `Session ${cmd.sessionKey} not found`,
        });
        return;
      }

      // If the leader had requested approval and the user sends a message
      // instead of clicking "Approve", treat it as "changes requested".
      let prompt = cmd.prompt;
      if (sendSession.taskState?.approval?.requested) {
        sendSession.taskState.approval = null;
        prompt = `[The user has reviewed your changes and is requesting modifications instead of approving. Their feedback follows.]\n\n${prompt}`;
        bus.emitToSession(cmd.sessionKey!, {
          type: "approval_resolved",
          sessionKey: cmd.sessionKey,
          action: "changes_requested",
          timestamp: Date.now(),
        });
      }

      // Refresh the session's thinking config from the latest send_message
      // payload — the user may have changed effort/display since session start.
      const turnThinking: ThinkingConfig | null = isValidThinkingConfig(cmd.thinkingConfig)
        ? cmd.thinkingConfig
        : sendSession.thinkingConfig;

      const resumeLeader = (cwd: string): void => {
        registry.start({
          sessionKey: cmd.sessionKey!,
          prompt,
          cwd,
          resumeId: sendSession.sessionId ?? undefined,
          systemPrompt: cmd.systemPrompt ?? undefined,
          role: sendSession.role,
          thinkingConfig: turnThinking,
        });
      };

      // ── Start a fresh approval cycle when the previous worktree is gone ──
      // After a successful merge or discard the worktree + branch are
      // removed, but the leader session stays alive so the user can keep
      // working. When they send a new prompt, create a fresh worktree so
      // the next round of changes stays isolated instead of landing
      // directly on the user's main branch.
      const needsNewWorktree =
        sendSession.role === "leader" &&
        sendSession.worktreeIsolation &&
        !sendSession.worktree;

      if (needsNewWorktree) {
        createWorktree(sendSession.cwd, cmd.sessionKey)
          .then((worktreeInfo) => {
            sendSession.worktree = worktreeInfo;
            sendSession.cwd = worktreeInfo.path;
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_created",
              sessionKey: cmd.sessionKey,
              worktreePath: worktreeInfo.path,
              branch: worktreeInfo.branch,
            });
            resumeLeader(worktreeInfo.path);
          })
          .catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(
              `[worktree] Failed to create follow-up worktree for ${cmd.sessionKey}: ${errMsg}`,
            );
            // Don't silently continue with isolation disabled — surface the
            // failure so the user can decide (fix git state, toggle isolation
            // off explicitly, etc.). Session stays idle.
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_failed",
              sessionKey: cmd.sessionKey,
              error: `Follow-up worktree creation failed: ${errMsg}`,
            });
          });
      } else {
        resumeLeader(sendSession.cwd);
      }
      break;
    }

    case "stop_session": {
      if (!cmd.sessionKey) return;
      const stopSession = registry.get(cmd.sessionKey);
      if (stopSession) {
        // Cancel any pending wait timer
        if (stopSession.waitTimerId) {
          stopSession.clearWaitTimer();
          bus.emitToSession(cmd.sessionKey, {
            type: "wait_state",
            sessionKey: cmd.sessionKey,
            action: "cancelled",
            reason: "Session stopped",
            timestamp: Date.now(),
          });
        }
        stopSession.abortController.abort();
        stopSession.status = "stopped";
        const stopEvent: BufferedEvent = {
          type: "session_status",
          sessionKey: cmd.sessionKey,
          status: "stopped",
          timestamp: Date.now(),
        };
        stopSession.bufferEvent(stopEvent);
        bus.emitToSession(cmd.sessionKey, stopEvent);
      }
      break;
    }

    case "sync_session": {
      if (!cmd.sessionKey) return;
      const syncSession = registry.get(cmd.sessionKey);
      if (!syncSession) {
        unicastToSession(ws, cmd.sessionKey, {
          type: "sync_response",
          sessionKey: cmd.sessionKey,
          found: false,
        });
        return;
      }
      unicastToSession(ws, cmd.sessionKey, {
        type: "sync_response",
        sessionKey: cmd.sessionKey,
        found: true,
        status: syncSession.status,
        sessionId: syncSession.sessionId,
        cwd: syncSession.cwd,
        totalCost: syncSession.totalCost,
        turns: syncSession.turns,
        lastError: syncSession.lastError,
        model: syncSession.model,
        permissionMode: syncSession.permissionMode,
        initData: syncSession.initData,
        worktree: syncSession.worktree,
        approval: syncSession.taskState?.approval ?? null,
        renderState: syncSession.renderState ?? null,
        taskName: syncSession.taskName,
        role: syncSession.role,
        activeMinions: syncSession.taskState
          ? Array.from(syncSession.taskState.tasks.entries())
              .filter(([, t]) => t.status === "planned" || t.status === "running")
              .map(([id, t]) => ({ taskId: id, title: t.title, status: t.status, sessionKey: t.minionSessionKey }))
          : [],
        events: syncSession.eventBuffer,
      });

      // If this session has dashboard render state, re-send it as a
      // render_update so the RenderNode's existing subscription picks it up
      // (handles page refresh / WebSocket reconnect recovery).
      if (syncSession.renderState && syncSession.renderState.components.length > 0) {
        unicastToSession(ws, cmd.sessionKey, {
          type: "render_update",
          leaderSessionKey: cmd.sessionKey,
          action: "set",
          layout: {
            title: syncSession.renderState.title,
            columns: syncSession.renderState.columns,
            gap: syncSession.renderState.gap,
          },
          components: syncSession.renderState.components,
        });
      }
      break;
    }

    case "list_sessions": {
      unicastGlobal(ws, {
        type: "session_list",
        sessions: registry.snapshot(),
      });
      break;
    }

    // ────────────────────────────────────────────────────
    // Execution control
    // ────────────────────────────────────────────────────

    case "interrupt": {
      const intSession = getSessionOrError(cmd.sessionKey, ws);
      if (!intSession) return;
      if (!intSession.queryHandle) {
        sendControlError(ws, "interrupt", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      intSession.queryHandle
        .interrupt()
        .then(() => {
          sendControlResponse(ws, "interrupt", cmd.sessionKey!, cmd.requestId);
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "interrupt",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    // interrupt_session is the frontend alias for "interrupt" — same behaviour.
    case "interrupt_session": {
      const intSSession = getSessionOrError(cmd.sessionKey, ws);
      if (!intSSession) return;
      if (!intSSession.queryHandle) {
        sendControlError(ws, "interrupt_session", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      intSSession.queryHandle
        .interrupt()
        .then(() => {
          sendControlResponse(ws, "interrupt_session", cmd.sessionKey!, cmd.requestId);
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "interrupt_session",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "close_session": {
      const closeSession = getSessionOrError(cmd.sessionKey, ws);
      if (!closeSession) return;
      closeSession.clearWaitTimer();
      if (closeSession.queryHandle) {
        closeSession.queryHandle.close();
      }
      closeSession.status = "stopped";
      closeSession.queryHandle = null;
      const closeEvent: BufferedEvent = {
        type: "session_status",
        sessionKey: cmd.sessionKey!,
        status: "stopped",
        timestamp: Date.now(),
      };
      closeSession.bufferEvent(closeEvent);
      bus.emitToSession(cmd.sessionKey!, closeEvent);
      sendControlResponse(ws, "close_session", cmd.sessionKey!, cmd.requestId);
      break;
    }

    case "remove_session": {
      if (!cmd.sessionKey) {
        unicastGlobal(ws, { type: "error", message: "sessionKey required" });
        return;
      }
      const removeSession = registry.get(cmd.sessionKey);
      if (removeSession) {
        removeSession.clearWaitTimer();
        // Stop if still running
        if (removeSession.queryHandle) {
          removeSession.queryHandle.close();
        }
        removeSession.abortController.abort();

        // Clean up worktree if this session owns one
        if (removeSession.worktree) {
          const wtPath = removeSession.worktree.path;
          const wtProject = removeSession.worktree.projectPath;
          removeWorktree(wtPath, wtProject).catch((err: unknown) => {
            console.warn(`[worktree] Cleanup on remove_session failed for ${cmd.sessionKey}: ${err instanceof Error ? err.message : err}`);
          });
          removeSession.worktree = null;
        }

        registry.delete(cmd.sessionKey);
        removePersistedSession(cmd.sessionKey);
      }
      // Broadcast updated session list to all clients
      bus.emitGlobal({ type: "session_list", sessions: registry.snapshot() });
      break;
    }

    // ────────────────────────────────────────────────────
    // Configuration control
    // ────────────────────────────────────────────────────

    case "set_permission_mode": {
      const permSession = getSessionOrError(cmd.sessionKey, ws);
      if (!permSession) return;
      if (!cmd.permissionMode) {
        sendControlError(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, "permissionMode required");
        return;
      }
      if (!permSession.queryHandle) {
        sendControlError(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      permSession.queryHandle
        .setPermissionMode(cmd.permissionMode as never)
        .then(() => {
          permSession.permissionMode = cmd.permissionMode!;
          sendControlResponse(ws, "set_permission_mode", cmd.sessionKey!, cmd.requestId, {
            permissionMode: cmd.permissionMode,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "set_permission_mode",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "set_model": {
      const modelSession = getSessionOrError(cmd.sessionKey, ws);
      if (!modelSession) return;
      if (!modelSession.queryHandle) {
        sendControlError(ws, "set_model", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      modelSession.queryHandle
        .setModel(cmd.model)
        .then(() => {
          modelSession.model = cmd.model ?? null;
          sendControlResponse(ws, "set_model", cmd.sessionKey!, cmd.requestId, {
            model: cmd.model,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "set_model",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    // ────────────────────────────────────────────────────
    // Task control
    // ────────────────────────────────────────────────────

    case "stop_task": {
      const taskSession = getSessionOrError(cmd.sessionKey, ws);
      if (!taskSession) return;
      if (!cmd.taskId) {
        sendControlError(ws, "stop_task", cmd.sessionKey!, cmd.requestId, "taskId required");
        return;
      }
      if (!taskSession.queryHandle) {
        sendControlError(ws, "stop_task", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      taskSession.queryHandle
        .stopTask(cmd.taskId)
        .then(() => {
          sendControlResponse(ws, "stop_task", cmd.sessionKey!, cmd.requestId, {
            taskId: cmd.taskId,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "stop_task",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    // ────────────────────────────────────────────────────
    // Worktree control
    // ────────────────────────────────────────────────────

    case "merge_worktree": {
      const mergeSession = getSessionOrError(cmd.sessionKey, ws);
      if (!mergeSession) return;
      if (!mergeSession.worktree) {
        sendControlError(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      const mergeProjectPath = mergeSession.worktree.projectPath;
      mergeAndCleanup(mergeSession.worktree)
        .then((result) => {
          if (result.success) {
            // Worktree + branch have been removed by mergeAndCleanup
            mergeSession.worktree = null;
            // Reset cwd to project path — worktree directory no longer exists
            mergeSession.cwd = mergeProjectPath;
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              timestamp: Date.now(),
            });
          } else {
            // Merge had conflicts — worktree stays active for retry/discard
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merge_failed",
              sessionKey: cmd.sessionKey,
              result,
              timestamp: Date.now(),
            });
          }
          sendControlResponse(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, { result });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "merge_worktree", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    case "discard_worktree": {
      const discardSession = getSessionOrError(cmd.sessionKey, ws);
      if (!discardSession) return;
      if (!discardSession.worktree) {
        sendControlError(ws, "discard_worktree", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      const worktreePath = discardSession.worktree.path;
      const worktreeProject = discardSession.worktree.projectPath;
      // Clear approval state if pending
      if (discardSession.taskState?.approval) {
        discardSession.taskState.approval = null;
      }
      removeWorktree(worktreePath, worktreeProject)
        .then(() => {
          discardSession.worktree = null;
          // Reset cwd to the main project path — the worktree directory no longer exists
          discardSession.cwd = worktreeProject;
          bus.emitToSession(cmd.sessionKey!, {
            type: "worktree_removed",
            sessionKey: cmd.sessionKey,
            timestamp: Date.now(),
          });
          bus.emitToSession(cmd.sessionKey!, {
            type: "approval_resolved",
            sessionKey: cmd.sessionKey,
            action: "discarded",
            timestamp: Date.now(),
          });
          // Leave the session idle. If the user sends a follow-up message,
          // send_message will lazily create a fresh worktree (since
          // session.worktreeIsolation is still true) before resuming.
          sendControlResponse(ws, "discard_worktree", cmd.sessionKey!, cmd.requestId);
        })
        .catch((err: unknown) => {
          sendControlError(ws, "discard_worktree", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    case "get_worktree_diff": {
      const diffSession = getSessionOrError(cmd.sessionKey, ws);
      if (!diffSession) return;
      if (!diffSession.worktree) {
        sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      getDetailedDiff(diffSession.worktree)
        .then((diff) => {
          sendControlResponse(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, { diff });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    case "approve_changes": {
      const approveSession = getSessionOrError(cmd.sessionKey, ws);
      if (!approveSession) return;
      if (!approveSession.worktree) {
        sendControlError(ws, "approve_changes", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      // Capture the project path before cleanup removes the worktree directory
      const approveProjectPath = approveSession.worktree.projectPath;

      // ── Abort the running agent BEFORE merge ──────────
      // Prevents race conditions where the agent tries to operate in the
      // worktree directory while/after it's being deleted.
      if (approveSession.status === "running") {
        approveSession.abortController.abort();
      }
      // Cancel any pending wait timer
      approveSession.clearWaitTimer();

      // NOTE: Don't clear approval state yet — wait until merge succeeds.
      // If merge fails, the approval UI should remain visible for retry.
      mergeAndCleanup(approveSession.worktree)
        .then((result) => {
          if (result.success) {
            // Now clear approval state — merge confirmed
            if (approveSession.taskState?.approval) {
              approveSession.taskState.approval = null;
            }
            approveSession.worktree = null;
            // Reset cwd to the main project path — the worktree directory no longer exists
            approveSession.cwd = approveProjectPath;
            // Mark session as completed — don't resume the agent.
            // The worktree is gone; resuming would cause errors as the agent
            // tries to operate in a deleted directory or with stale context.
            approveSession.status = "completed";
            // Buffer a session_status event so sync picks up the completed state
            const completedStatusEvent: BufferedEvent = {
              type: "session_status",
              sessionKey: cmd.sessionKey,
              status: "completed",
              timestamp: Date.now(),
            };
            approveSession.bufferEvent(completedStatusEvent);
            bus.emitToSession(cmd.sessionKey!, completedStatusEvent);
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              approved: true,
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "approval_resolved",
              sessionKey: cmd.sessionKey,
              action: "approved",
              timestamp: Date.now(),
            });
            // Broadcast a dedicated completion event so the UI can transition
            // to a clean "completed" state with a "New Session" option.
            bus.emitToSession(cmd.sessionKey!, {
              type: "session_completed",
              sessionKey: cmd.sessionKey,
              reason: "merged",
              timestamp: Date.now(),
            });
          } else {
            // Merge failed — keep approval state so the UI stays visible
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merge_failed",
              sessionKey: cmd.sessionKey,
              result,
              timestamp: Date.now(),
            });
          }
          sendControlResponse(ws, "approve_changes", cmd.sessionKey!, cmd.requestId, { result });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "approve_changes", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    case "force_merge": {
      console.log(`[worktree] force_merge received for ${cmd.sessionKey}`);
      const forceSession = getSessionOrError(cmd.sessionKey, ws);
      if (!forceSession) { console.log("[worktree] force_merge: session not found"); return; }
      if (!forceSession.worktree) {
        console.log("[worktree] force_merge: no worktree on session");
        sendControlError(ws, "force_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      console.log(`[worktree] force_merge: starting merge for ${forceSession.worktree.branch} at ${forceSession.worktree.path}`);
      // Capture the project path before cleanup removes the worktree directory
      const forceProjectPath = forceSession.worktree.projectPath;

      // ── Abort the running agent BEFORE merge ──────────
      if (forceSession.status === "running") {
        forceSession.abortController.abort();
      }
      forceSession.clearWaitTimer();

      mergeAndCleanup(forceSession.worktree, undefined, { force: true })
        .then((result) => {
          console.log(`[worktree] force_merge result:`, JSON.stringify(result));
          if (result.success) {
            if (forceSession.taskState?.approval) {
              forceSession.taskState.approval = null;
            }
            forceSession.worktree = null;
            // Reset cwd to the main project path — the worktree directory no longer exists
            forceSession.cwd = forceProjectPath;
            // Mark session as completed — don't resume the agent
            forceSession.status = "completed";
            // Buffer a session_status event so sync picks up the completed state
            const forceCompletedEvent: BufferedEvent = {
              type: "session_status",
              sessionKey: cmd.sessionKey,
              status: "completed",
              timestamp: Date.now(),
            };
            forceSession.bufferEvent(forceCompletedEvent);
            bus.emitToSession(cmd.sessionKey!, forceCompletedEvent);
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              approved: true,
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "approval_resolved",
              sessionKey: cmd.sessionKey,
              action: "approved",
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "session_completed",
              sessionKey: cmd.sessionKey,
              reason: "merged",
              timestamp: Date.now(),
            });
          } else {
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merge_failed",
              sessionKey: cmd.sessionKey,
              result,
              timestamp: Date.now(),
            });
          }
          sendControlResponse(ws, "force_merge", cmd.sessionKey!, cmd.requestId, { result });
        })
        .catch((err: unknown) => {
          console.error(`[worktree] force_merge error:`, err instanceof Error ? err.message : String(err));
          sendControlError(ws, "force_merge", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    case "theirs_merge": {
      const theirsSession = getSessionOrError(cmd.sessionKey, ws);
      if (!theirsSession) return;
      if (!theirsSession.worktree) {
        sendControlError(ws, "theirs_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      // Merge using -X theirs: on conflicts, keep the main branch's version
      const theirsProjectPath = theirsSession.worktree.projectPath;
      // Abort the running agent before merge
      if (theirsSession.status === "running") {
        theirsSession.abortController.abort();
      }
      theirsSession.clearWaitTimer();
      mergeAndCleanup(theirsSession.worktree, undefined, { strategy: "theirs" })
        .then((result) => {
          if (result.success) {
            if (theirsSession.taskState?.approval) {
              theirsSession.taskState.approval = null;
            }
            theirsSession.worktree = null;
            theirsSession.cwd = theirsProjectPath;
            theirsSession.status = "completed";
            const theirsCompletedEvent: BufferedEvent = {
              type: "session_status",
              sessionKey: cmd.sessionKey,
              status: "completed",
              timestamp: Date.now(),
            };
            theirsSession.bufferEvent(theirsCompletedEvent);
            bus.emitToSession(cmd.sessionKey!, theirsCompletedEvent);
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              approved: true,
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "approval_resolved",
              sessionKey: cmd.sessionKey,
              action: "approved",
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "session_completed",
              sessionKey: cmd.sessionKey,
              reason: "merged",
              timestamp: Date.now(),
            });
          } else {
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merge_failed",
              sessionKey: cmd.sessionKey,
              result,
              timestamp: Date.now(),
            });
          }
          sendControlResponse(ws, "theirs_merge", cmd.sessionKey!, cmd.requestId, { result });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "theirs_merge", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    case "retry_merge": {
      // Re-attempt a clean merge after user may have manually resolved conflicts
      // in the worktree (e.g. via terminal or editor).
      const retrySession = getSessionOrError(cmd.sessionKey, ws);
      if (!retrySession) return;
      if (!retrySession.worktree) {
        sendControlError(ws, "retry_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      const retryProjectPath = retrySession.worktree.projectPath;
      // Abort the running agent before merge
      if (retrySession.status === "running") {
        retrySession.abortController.abort();
      }
      retrySession.clearWaitTimer();
      mergeAndCleanup(retrySession.worktree)
        .then((result) => {
          if (result.success) {
            if (retrySession.taskState?.approval) {
              retrySession.taskState.approval = null;
            }
            retrySession.worktree = null;
            retrySession.cwd = retryProjectPath;
            retrySession.status = "completed";
            const retryCompletedEvent: BufferedEvent = {
              type: "session_status",
              sessionKey: cmd.sessionKey,
              status: "completed",
              timestamp: Date.now(),
            };
            retrySession.bufferEvent(retryCompletedEvent);
            bus.emitToSession(cmd.sessionKey!, retryCompletedEvent);
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              approved: true,
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "approval_resolved",
              sessionKey: cmd.sessionKey,
              action: "approved",
              timestamp: Date.now(),
            });
            bus.emitToSession(cmd.sessionKey!, {
              type: "session_completed",
              sessionKey: cmd.sessionKey,
              reason: "merged",
              timestamp: Date.now(),
            });
          } else {
            // Still has conflicts — report back
            bus.emitToSession(cmd.sessionKey!, {
              type: "worktree_merge_failed",
              sessionKey: cmd.sessionKey,
              result,
              timestamp: Date.now(),
            });
          }
          sendControlResponse(ws, "retry_merge", cmd.sessionKey!, cmd.requestId, { result });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "retry_merge", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
        });
      break;
    }

    // ────────────────────────────────────────────────────
    // File & state control
    // ────────────────────────────────────────────────────

    case "rewind_files": {
      const rwSession = getSessionOrError(cmd.sessionKey, ws);
      if (!rwSession) return;
      if (!cmd.userMessageId) {
        sendControlError(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, "userMessageId required");
        return;
      }
      if (!rwSession.queryHandle) {
        sendControlError(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      rwSession.queryHandle
        .rewindFiles(cmd.userMessageId, { dryRun: cmd.dryRun })
        .then((result) => {
          sendControlResponse(ws, "rewind_files", cmd.sessionKey!, cmd.requestId, {
            result,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "rewind_files",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "seed_read_state": {
      const seedSession = getSessionOrError(cmd.sessionKey, ws);
      if (!seedSession) return;
      if (!cmd.path || cmd.mtime === undefined) {
        sendControlError(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId, "path and mtime required");
        return;
      }
      if (!seedSession.queryHandle) {
        sendControlError(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      seedSession.queryHandle
        .seedReadState(cmd.path, cmd.mtime)
        .then(() => {
          sendControlResponse(ws, "seed_read_state", cmd.sessionKey!, cmd.requestId);
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "seed_read_state",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    // ────────────────────────────────────────────────────
    // Info queries
    // ────────────────────────────────────────────────────

    case "get_context_usage": {
      const ctxSession = getSessionOrError(cmd.sessionKey, ws);
      if (!ctxSession?.queryHandle) {
        sendControlError(ws, "get_context_usage", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      ctxSession.queryHandle
        .getContextUsage()
        .then((usage) => {
          sendControlResponse(ws, "get_context_usage", cmd.sessionKey!, cmd.requestId, {
            usage,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "get_context_usage",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "get_supported_models": {
      const modelsSession = getSessionOrError(cmd.sessionKey, ws);
      if (!modelsSession?.queryHandle) {
        sendControlError(ws, "get_supported_models", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      modelsSession.queryHandle
        .supportedModels()
        .then((models) => {
          sendControlResponse(ws, "get_supported_models", cmd.sessionKey!, cmd.requestId, {
            models,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "get_supported_models",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "get_supported_commands": {
      const cmdsSession = getSessionOrError(cmd.sessionKey, ws);
      if (!cmdsSession?.queryHandle) {
        sendControlError(ws, "get_supported_commands", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      cmdsSession.queryHandle
        .supportedCommands()
        .then((commands) => {
          sendControlResponse(ws, "get_supported_commands", cmd.sessionKey!, cmd.requestId, {
            commands,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "get_supported_commands",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "get_supported_agents": {
      const agentsSession = getSessionOrError(cmd.sessionKey, ws);
      if (!agentsSession?.queryHandle) {
        sendControlError(ws, "get_supported_agents", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      agentsSession.queryHandle
        .supportedAgents()
        .then((agents) => {
          sendControlResponse(ws, "get_supported_agents", cmd.sessionKey!, cmd.requestId, {
            agents,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "get_supported_agents",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "get_account_info": {
      const acctSession = getSessionOrError(cmd.sessionKey, ws);
      if (!acctSession?.queryHandle) {
        sendControlError(ws, "get_account_info", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      acctSession.queryHandle
        .accountInfo()
        .then((account) => {
          sendControlResponse(ws, "get_account_info", cmd.sessionKey!, cmd.requestId, {
            account,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "get_account_info",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "get_mcp_server_status": {
      const mcpStatusSession = getSessionOrError(cmd.sessionKey, ws);
      if (!mcpStatusSession?.queryHandle) {
        sendControlError(ws, "get_mcp_server_status", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      mcpStatusSession.queryHandle
        .mcpServerStatus()
        .then((servers) => {
          sendControlResponse(ws, "get_mcp_server_status", cmd.sessionKey!, cmd.requestId, {
            servers,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "get_mcp_server_status",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    // ────────────────────────────────────────────────────
    // MCP server control
    // ────────────────────────────────────────────────────

    case "reconnect_mcp_server": {
      const reconnSession = getSessionOrError(cmd.sessionKey, ws);
      if (!reconnSession) return;
      if (!cmd.serverName) {
        sendControlError(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, "serverName required");
        return;
      }
      if (!reconnSession.queryHandle) {
        sendControlError(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      reconnSession.queryHandle
        .reconnectMcpServer(cmd.serverName)
        .then(() => {
          sendControlResponse(ws, "reconnect_mcp_server", cmd.sessionKey!, cmd.requestId, {
            serverName: cmd.serverName,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "reconnect_mcp_server",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    case "toggle_mcp_server": {
      const toggleSession = getSessionOrError(cmd.sessionKey, ws);
      if (!toggleSession) return;
      if (!cmd.serverName || cmd.enabled === undefined) {
        sendControlError(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, "serverName and enabled required");
        return;
      }
      if (!toggleSession.queryHandle) {
        sendControlError(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, "No active query");
        return;
      }
      toggleSession.queryHandle
        .toggleMcpServer(cmd.serverName, cmd.enabled)
        .then(() => {
          sendControlResponse(ws, "toggle_mcp_server", cmd.sessionKey!, cmd.requestId, {
            serverName: cmd.serverName,
            enabled: cmd.enabled,
          });
        })
        .catch((err: unknown) => {
          sendControlError(
            ws,
            "toggle_mcp_server",
            cmd.sessionKey!,
            cmd.requestId,
            err instanceof Error ? err.message : String(err),
          );
        });
      break;
    }

    default: {
      unicastGlobal(ws, {
        type: "error",
        message: `Unknown command type: ${(cmd as WsCommand).type}`,
      });
    }
  }
}

// ── WebSocket handlers ───────────────────────────────────

wss.on("connection", (ws) => {
  console.log("Client connected");

  // Send current session list on connect
  unicastGlobal(ws, {
    type: "session_list",
    sessions: registry.snapshot(),
  });

  ws.on("message", (raw) => {
    try {
      const cmd = JSON.parse(String(raw)) as WsCommand;
      handleCommand(cmd, ws);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      unicastGlobal(ws, { type: "error", message: msg });
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
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
      console.warn(`Worktree cleanup skipped for ${project.path}:`, err instanceof Error ? err.message : err);
    });
  }
});

// ── Graceful shutdown: clean up all active worktrees ────────────────────────
async function shutdownCleanup(): Promise<void> {
  console.log("[shutdown] Cleaning up active worktrees...");
  const cleanups: Promise<void>[] = [];
  for (const [key, session] of registry) {
    if (session.worktree) {
      console.log(`[shutdown] Removing worktree for ${key}: ${session.worktree.branch}`);
      cleanups.push(
        removeWorktree(session.worktree.path, session.worktree.projectPath).catch((err: unknown) => {
          console.warn(`[shutdown] Failed to remove worktree for ${key}: ${err instanceof Error ? err.message : err}`);
        }),
      );
    }
  }
  await Promise.allSettled(cleanups);
  console.log("[shutdown] Worktree cleanup complete.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdownCleanup());
process.on("SIGTERM", () => void shutdownCleanup());
