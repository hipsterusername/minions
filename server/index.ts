import express from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createProjectRoutes } from "./routes/projects.ts";
import { createFileRoutes } from "./routes/files.ts";
import { createTaskToolsForLeader, type TaskManagerState } from "./task-tools.ts";
import { createMinionToolsForSession } from "./minion-tools.ts";
import { createRenderToolsForLeader, type RenderState } from "./render-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../src/prompts/minion-system.ts";
import { createWorktree, removeWorktree, mergeAndCleanup, getWorktreeStatus, getDetailedDiff, isGitRepo, cleanupStaleWorktrees, type WorktreeInfo } from "./worktree.ts";
import { validateSessionCwd } from "./path-guard.ts";

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

const MAX_BUFFERED_EVENTS = 200;
const MAX_SESSIONS = 50;

interface BufferedEvent {
  type: string;
  sessionKey: string;
  message?: unknown;
  status?: string;
  error?: string;
  sessionId?: string;
  timestamp: number;
}

interface Session {
  id: string;
  sessionId: string | null;
  status: "running" | "idle" | "stopped" | "error";
  abortController: AbortController;
  queryHandle: Query | null;
  cwd: string;
  eventBuffer: BufferedEvent[];
  totalCost: number;
  turns: number;
  lastError: string | null;
  model: string | null;
  permissionMode: string | null;
  initData: Record<string, unknown> | null;
  /** For leader sessions: the task manager state tracking minion tasks */
  taskState: TaskManagerState | null;
  role: "leader" | "minion" | "default";
  taskName: string | null;
  worktree: WorktreeInfo | null;
  worktreeIsolation: boolean;
  /** Active wait timer for wait_and_continue (leader only) */
  waitTimerId: ReturnType<typeof setTimeout> | null;
  /** Current render dashboard state (leader only) — kept in sync by render MCP tools */
  renderState: RenderState | null;
}

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
  role?: "leader" | "minion" | "default";
  worktreeIsolation?: boolean;
  // Configuration params
  model?: string;
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

const sessions = new Map<string, Session>();
let keyCounter = 0;

function generateKey(): string {
  keyCounter += 1;
  return `session-${Date.now().toString(36)}-${keyCounter}`;
}

function bufferEvent(session: Session, event: BufferedEvent): void {
  session.eventBuffer.push(event);
  if (session.eventBuffer.length > MAX_BUFFERED_EVENTS) {
    session.eventBuffer = session.eventBuffer.slice(-MAX_BUFFERED_EVENTS);
  }
}

function broadcast(wsServer: WebSocketServer, data: unknown): void {
  const msg = JSON.stringify(data);
  for (const client of wsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

/** Helper: get session or send error, returns null on failure */
function getSessionOrError(
  sessionKey: string | undefined,
  ws: WebSocket,
): Session | null {
  if (!sessionKey) {
    ws.send(JSON.stringify({ type: "error", message: "sessionKey required" }));
    return null;
  }
  const session = sessions.get(sessionKey);
  if (!session) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: `Session ${sessionKey} not found`,
      }),
    );
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
  ws.send(
    JSON.stringify({
      type: "control_response",
      command,
      sessionKey,
      requestId: requestId ?? null,
      success: true,
      ...data,
    }),
  );
}

/** Helper: send a control_error back to the requesting client */
function sendControlError(
  ws: WebSocket,
  command: string,
  sessionKey: string,
  requestId: string | undefined,
  error: string,
): void {
  ws.send(
    JSON.stringify({
      type: "control_response",
      command,
      sessionKey,
      requestId: requestId ?? null,
      success: false,
      error,
    }),
  );
}

/** Derive a short task name from the user prompt */
function deriveTaskName(prompt: string): string {
  // Strip connected-context wrapper if present
  let clean = prompt.replace(/<connected-context>[\s\S]*?<\/connected-context>\s*/g, "").trim();
  // Take first line only
  clean = (clean.split("\n")[0] ?? "").trim();
  // Truncate to 40 chars
  if (clean.length > 40) {
    clean = clean.slice(0, 37) + "…";
  }
  return clean || "Leader Session";
}

// ── Session runner ──────────────────────────────────────

async function runSession(
  wsServer: WebSocketServer,
  sessionKey: string,
  prompt: string,
  cwd: string,
  resumeId?: string,
  systemPrompt?: string,
  role?: "leader" | "minion" | "default",
  worktreeIsolation?: boolean,
  parentWorktree?: WorktreeInfo,
  initialModel?: string,
): Promise<void> {
  const existing = sessions.get(sessionKey);
  const abortController = new AbortController();
  const session: Session = {
    id: sessionKey,
    sessionId: resumeId ?? existing?.sessionId ?? null,
    status: "running",
    abortController,
    queryHandle: null,
    cwd,
    eventBuffer: existing?.eventBuffer ?? [],
    totalCost: existing?.totalCost ?? 0,
    turns: existing?.turns ?? 0,
    lastError: null,
    model: existing?.model ?? initialModel ?? null,
    permissionMode: existing?.permissionMode ?? null,
    initData: existing?.initData ?? null,
    taskState: existing?.taskState ?? null,
    role: role ?? existing?.role ?? "default",
    taskName: existing?.taskName ?? (role === "leader" ? deriveTaskName(prompt) : null),
    worktree: parentWorktree ?? existing?.worktree ?? null,
    worktreeIsolation: worktreeIsolation !== false,
    waitTimerId: null,
    renderState: null,
  };
  // Clear any existing wait timer when the session resumes (it's being continued)
  if (existing?.waitTimerId) {
    clearTimeout(existing.waitTimerId);
  }
  sessions.set(sessionKey, session);

  // ── Inherit parent worktree for minion sessions ──────
  if (parentWorktree) {
    session.cwd = parentWorktree.path;
    cwd = parentWorktree.path;
    console.log(`[worktree] Minion ${sessionKey} inheriting worktree ${parentWorktree.branch} at ${parentWorktree.path}`);
  }

  // ── Create worktree for leader sessions ──────────────
  const shouldCreateWorktree = worktreeIsolation !== false; // defaults to true
  if (role === "leader" && shouldCreateWorktree) {
    if (existing?.worktree) {
      // Resume: reuse existing worktree
      session.worktree = existing.worktree;
      session.cwd = existing.worktree.path;
      cwd = existing.worktree.path;
    } else {
      try {
        const inGitRepo = await isGitRepo(cwd);
        if (inGitRepo) {
          const worktreeInfo = await createWorktree(cwd, sessionKey);
          session.worktree = worktreeInfo;
          session.cwd = worktreeInfo.path;
          cwd = worktreeInfo.path;
          broadcast(wsServer, {
            type: "worktree_created",
            sessionKey,
            worktreePath: worktreeInfo.path,
            branch: worktreeInfo.branch,
          });
        } else {
          // Not a git repo — worktree isolation was requested but is impossible.
          // Notify the frontend so the user knows they're working on the live tree.
          console.warn(`[worktree] ${sessionKey}: not a git repo — isolation unavailable`);
          broadcast(wsServer, {
            type: "worktree_failed",
            sessionKey,
            error: "Project is not a git repository. Worktree isolation is unavailable.",
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[worktree] Failed to create worktree for ${sessionKey}: ${errMsg}`);
        // Do NOT silently fall back. Notify the user and let them decide.
        broadcast(wsServer, {
          type: "worktree_failed",
          sessionKey,
          error: `Worktree creation failed: ${errMsg}`,
        });
        // Session still starts, but without isolation — the user is informed.
        session.worktreeIsolation = false;
      }
    }
  }

  const statusEvent: BufferedEvent = {
    type: "session_status",
    sessionKey,
    status: "running",
    timestamp: Date.now(),
  };
  bufferEvent(session, statusEvent);
  broadcast(wsServer, statusEvent);

  try {
    // All sessions (leader, minion, generic) get full coding tools.
    // Leaders can also delegate parallel work to minions via assign_task MCP tool.
    const codeTools = [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "Agent",
      "WebFetch",
      "WebSearch",
    ];

    // MCP tools must be explicitly allowed so sessions (especially in
    // worktree dirs) don't prompt for permission at runtime.
    const mcpTools = role === "leader"
      ? [
          "mcp__task-manager__plan_task",
          "mcp__task-manager__assign_task",
          "mcp__task-manager__complete_task",
          "mcp__task-manager__get_task_status",
          "mcp__task-manager__set_task_name",
          "mcp__task-manager__wait_and_continue",
          "mcp__task-manager__request_approval",
          "mcp__render-dashboard__render_set",
          "mcp__render-dashboard__render_patch",
          "mcp__render-dashboard__render_append",
          "mcp__render-dashboard__render_remove",
        ]
      : role === "minion"
        ? [
            "mcp__minion-status__report_step",
            "mcp__minion-status__report_done",
            "mcp__minion-status__report_fail",
          ]
        : [];

    const fullTools = [...codeTools, ...mcpTools];

    const options: Record<string, unknown> = {
      cwd: session.cwd,
      resume: resumeId,
      allowedTools: fullTools,
      disallowedTools: [],
      permissionMode: "auto",
      abortController,
      includePartialMessages: true,
      promptSuggestions: true,
    };
    if (systemPrompt) {
      options["systemPrompt"] = systemPrompt;
    }
    if (session.model) {
      options["model"] = session.model;
    }

    // For leader sessions, ALWAYS attach task management MCP tools —
    // even on resume.  The SDK creates a fresh MCP-server map on every
    // query() call, so we must re-provide the server each time.
    // We preserve the existing taskState so get_task_status still
    // reflects previously-assigned tasks.
    if (role === "leader") {
      const { mcpServer, taskState } = createTaskToolsForLeader({
        leaderSessionKey: sessionKey,
        wss: wsServer,
        startMinionSession: (params) => {
          // Fire-and-forget: start a minion session in the leader's worktree
          runSession(
            wsServer,
            params.sessionKey,
            params.prompt,
            params.cwd,
            undefined,
            params.systemPrompt,
            "minion",
            false,              // worktreeIsolation: false — don't create a new worktree
            session.worktree ?? undefined,  // inherit leader's worktree
          );
        },
        cwd: session.cwd,
        minionSystemPrompt: MINION_SYSTEM_PROMPT,
        existingTaskState: session.taskState ?? undefined,
        worktreeBranch: session.worktree?.branch ?? null,
        worktreeInfo: session.worktree ?? null,
        worktreeIsolation: session.worktreeIsolation,
        scheduleWaitContinue: (durationMs: number, reason: string) => {
          // Cancel any previous wait timer
          if (session.waitTimerId) clearTimeout(session.waitTimerId);

          console.log(`[wait] Leader ${sessionKey} waiting ${durationMs}ms: ${reason}`);

          session.waitTimerId = setTimeout(() => {
            session.waitTimerId = null;

            // Broadcast that the wait has ended
            broadcast(wsServer, {
              type: "wait_state",
              sessionKey,
              action: "completed",
              reason,
              timestamp: Date.now(),
            });

            // Resume the session with "Continue"
            console.log(`[wait] Resuming leader ${sessionKey} after ${durationMs}ms wait`);
            runSession(
              wsServer,
              sessionKey,
              `Continue. The ${Math.round(durationMs / 1000)}s wait has elapsed (reason: ${reason}). Pick up where you left off.`,
              session.cwd,
              session.sessionId ?? undefined,
              systemPrompt,
              "leader",
            );
          }, durationMs);
        },
      });
      const { mcpServer: renderMcp, renderState } = createRenderToolsForLeader({
        leaderSessionKey: sessionKey,
        wss: wsServer,
      });
      options["mcpServers"] = { "task-manager": mcpServer, "render-dashboard": renderMcp };
      session.taskState = taskState;
      session.renderState = renderState;
    }

    // For minion sessions, attach status-reporting MCP tools
    if (role === "minion") {
      const { mcpServer: minionMcp } = createMinionToolsForSession({
        minionSessionKey: sessionKey,
        wss: wsServer,
      });
      const existing = (options["mcpServers"] as Record<string, unknown>) ?? {};
      options["mcpServers"] = { ...existing, "minion-status": minionMcp };
    }

    const handle = query({ prompt, options: options as never });

    session.queryHandle = handle;

    for await (const message of handle) {
      if (abortController.signal.aborted) break;

      const msg = message as Record<string, unknown>;

      // ── Capture init data from system/init event ──────
      if (
        message.type === "system" &&
        "subtype" in message &&
        message.subtype === "init"
      ) {
        session.sessionId = msg["session_id"] as string;
        session.model = (msg["model"] as string) ?? null;
        session.permissionMode = (msg["permissionMode"] as string) ?? null;
        session.initData = {
          tools: msg["tools"],
          model: msg["model"],
          mcp_servers: msg["mcp_servers"],
          permissionMode: msg["permissionMode"],
          slash_commands: msg["slash_commands"],
          skills: msg["skills"],
          claude_code_version: msg["claude_code_version"],
        };
      }

      // ── Forward ALL SDK events to connected clients ───
      const sdkEvent: BufferedEvent = {
        type: "sdk_event",
        sessionKey,
        message,
        timestamp: Date.now(),
      };
      bufferEvent(session, sdkEvent);
      broadcast(wsServer, sdkEvent);

      // ── Detect Agent tool subagent events from leader sessions ──
      // When the SDK's built-in Agent tool spawns a subagent, it emits
      // system events with subtype "task_started" / "task_notification".
      // We convert these into canvas-aware events so the frontend can
      // create and update Minion nodes automatically.
      if (session.role === "leader" && message.type === "system") {
        const subtype = (msg as Record<string, unknown>)["subtype"] as string | undefined;
        if (subtype === "task_started") {
          const taskId = (msg["task_id"] as string) ?? `agent-${Date.now().toString(36)}`;
          const description = (msg["description"] as string) ?? "Subagent task";
          broadcast(wsServer, {
            type: "agent_spawned",
            leaderSessionKey: sessionKey,
            taskId,
            title: description,
            description,
            timestamp: Date.now(),
          });
        }
        if (subtype === "task_notification") {
          const taskId = (msg["task_id"] as string) ?? "";
          const status = (msg["status"] as string) ?? "completed";
          const summary = (msg["summary"] as string) ?? "";
          broadcast(wsServer, {
            type: "agent_task_update",
            leaderSessionKey: sessionKey,
            taskId,
            status,
            summary,
            timestamp: Date.now(),
          });
        }
      }

      // ── Update session metadata on result ─────────────
      if (message.type === "result") {
        session.status = "idle";
        session.totalCost =
          (msg["total_cost_usd"] as number) ?? session.totalCost;
        session.turns = (msg["num_turns"] as number) ?? session.turns;
        const resultStatusEvent: BufferedEvent = {
          type: "session_status",
          sessionKey,
          status: "idle",
          sessionId: session.sessionId ?? undefined,
          timestamp: Date.now(),
        };
        bufferEvent(session, resultStatusEvent);
        broadcast(wsServer, resultStatusEvent);

        // ── Propagate minion completion back to leader's task state ──
        if (session.role === "minion") {
          for (const [leaderKey, otherSession] of sessions) {
            if (!otherSession.taskState) continue;
            for (const [, task] of otherSession.taskState.tasks) {
              if (task.minionSessionKey === sessionKey) {
                const isError = !!(msg["is_error"]);
                task.status = isError ? "failed" : "completed";
                task.result =
                  (msg["result"] as string) ??
                  (isError ? "Task failed" : "Task completed");
                // Broadcast so the frontend leader node and any subscribers learn
                // the task is done without needing to poll get_task_status.
                broadcast(wsServer, {
                  type: "minion_completed",
                  leaderSessionKey: leaderKey,
                  minionSessionKey: sessionKey,
                  taskId: task.taskId,
                  status: task.status,
                  result: task.result,
                  timestamp: Date.now(),
                });
                break;
              }
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    session.status = "error";
    session.lastError = errorMessage;
    const errorEvent: BufferedEvent = {
      type: "session_error",
      sessionKey,
      error: errorMessage,
      timestamp: Date.now(),
    };
    bufferEvent(session, errorEvent);
    broadcast(wsServer, errorEvent);
  }
}

// ── Command handler ─────────────────────────────────────

function handleCommand(
  wsServer: WebSocketServer,
  cmd: WsCommand,
  ws: WebSocket,
): void {
  switch (cmd.type) {
    // ────────────────────────────────────────────────────
    // Session lifecycle
    // ────────────────────────────────────────────────────

    case "create_session": {
      if (sessions.size >= MAX_SESSIONS) {
        ws.send(JSON.stringify({
          type: "error",
          message: `Maximum session limit (${MAX_SESSIONS}) reached. Remove unused sessions first.`,
        }));
        return;
      }
      const key = cmd.sessionKey ?? generateKey();
      const rawCwd = cmd.cwd ?? process.cwd();
      const cwd = validateSessionCwd(rawCwd);
      if (!cwd) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid cwd: must be under home directory" }));
        return;
      }
      const prompt = cmd.prompt ?? "Hello";
      runSession(wsServer, key, prompt, cwd, undefined, cmd.systemPrompt, cmd.role, cmd.worktreeIsolation, undefined, cmd.model);
      ws.send(
        JSON.stringify({
          type: "session_created",
          sessionKey: key,
        }),
      );
      break;
    }

    case "send_message": {
      if (!cmd.sessionKey || !cmd.prompt) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "sessionKey and prompt required",
          }),
        );
        return;
      }
      const sendSession = sessions.get(cmd.sessionKey);
      if (!sendSession) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Session ${cmd.sessionKey} not found`,
          }),
        );
        return;
      }

      // If the leader had requested approval and the user sends a message
      // instead of clicking "Approve", treat it as "changes requested".
      let prompt = cmd.prompt;
      if (sendSession.taskState?.approval?.requested) {
        sendSession.taskState.approval = null;
        prompt = `[The user has reviewed your changes and is requesting modifications instead of approving. Their feedback follows.]\n\n${prompt}`;
        broadcast(wsServer, {
          type: "approval_resolved",
          sessionKey: cmd.sessionKey,
          action: "changes_requested",
          timestamp: Date.now(),
        });
      }

      runSession(
        wsServer,
        cmd.sessionKey,
        prompt,
        sendSession.cwd,
        sendSession.sessionId ?? undefined,
        cmd.systemPrompt ?? undefined,
        sendSession.role,
      );
      break;
    }

    case "stop_session": {
      if (!cmd.sessionKey) return;
      const stopSession = sessions.get(cmd.sessionKey);
      if (stopSession) {
        // Cancel any pending wait timer
        if (stopSession.waitTimerId) {
          clearTimeout(stopSession.waitTimerId);
          stopSession.waitTimerId = null;
          broadcast(wsServer, {
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
        bufferEvent(stopSession, stopEvent);
        broadcast(wsServer, stopEvent);
      }
      break;
    }

    case "sync_session": {
      if (!cmd.sessionKey) return;
      const syncSession = sessions.get(cmd.sessionKey);
      if (!syncSession) {
        ws.send(
          JSON.stringify({
            type: "sync_response",
            sessionKey: cmd.sessionKey,
            found: false,
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
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
        }),
      );

      // If this session has dashboard render state, re-send it as a
      // render_update so the RenderNode's existing subscription picks it up
      // (handles page refresh / WebSocket reconnect recovery).
      if (syncSession.renderState && syncSession.renderState.components.length > 0) {
        ws.send(
          JSON.stringify({
            type: "render_update",
            leaderSessionKey: cmd.sessionKey,
            action: "set",
            layout: {
              title: syncSession.renderState.title,
              columns: syncSession.renderState.columns,
              gap: syncSession.renderState.gap,
            },
            components: syncSession.renderState.components,
          }),
        );
      }
      break;
    }

    case "list_sessions": {
      const sessionList = Array.from(sessions.entries()).map(([key, s]) => ({
        sessionKey: key,
        sessionId: s.sessionId,
        status: s.status,
        cwd: s.cwd,
        totalCost: s.totalCost,
        turns: s.turns,
        model: s.model,
        permissionMode: s.permissionMode,
        taskName: s.taskName,
        role: s.role,
        activeMinions: s.taskState
          ? Array.from(s.taskState.tasks.entries())
              .filter(([, t]) => t.status === "planned" || t.status === "running")
              .map(([id, t]) => ({ taskId: id, title: t.title, status: t.status, sessionKey: t.minionSessionKey }))
          : [],
      }));
      ws.send(
        JSON.stringify({
          type: "session_list",
          sessions: sessionList,
        }),
      );
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
      if (closeSession.waitTimerId) {
        clearTimeout(closeSession.waitTimerId);
        closeSession.waitTimerId = null;
      }
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
      bufferEvent(closeSession, closeEvent);
      broadcast(wsServer, closeEvent);
      sendControlResponse(ws, "close_session", cmd.sessionKey!, cmd.requestId);
      break;
    }

    case "remove_session": {
      if (!cmd.sessionKey) {
        ws.send(JSON.stringify({ type: "error", message: "sessionKey required" }));
        return;
      }
      const removeSession = sessions.get(cmd.sessionKey);
      if (removeSession) {
        // Clear any pending wait timer
        if (removeSession.waitTimerId) {
          clearTimeout(removeSession.waitTimerId);
          removeSession.waitTimerId = null;
        }
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

        sessions.delete(cmd.sessionKey);
      }
      // Broadcast updated session list to all clients
      const updatedList = Array.from(sessions.entries()).map(([key, s]) => ({
        sessionKey: key,
        sessionId: s.sessionId,
        status: s.status,
        cwd: s.cwd,
        totalCost: s.totalCost,
        turns: s.turns,
        model: s.model,
        permissionMode: s.permissionMode,
        taskName: s.taskName,
        role: s.role,
        activeMinions: s.taskState
          ? Array.from(s.taskState.tasks.entries())
              .filter(([, t]) => t.status === "planned" || t.status === "running")
              .map(([id, t]) => ({ taskId: id, title: t.title, status: t.status, sessionKey: t.minionSessionKey }))
          : [],
      }));
      broadcast(wsServer, { type: "session_list", sessions: updatedList });
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
      mergeAndCleanup(mergeSession.worktree)
        .then((result) => {
          if (result.success) {
            // Worktree + branch have been removed by mergeAndCleanup
            mergeSession.worktree = null;
            broadcast(wsServer, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              timestamp: Date.now(),
            });
          } else {
            // Merge had conflicts — worktree stays active for retry/discard
            broadcast(wsServer, {
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
          broadcast(wsServer, {
            type: "worktree_removed",
            sessionKey: cmd.sessionKey,
            timestamp: Date.now(),
          });
          broadcast(wsServer, {
            type: "approval_resolved",
            sessionKey: cmd.sessionKey,
            action: "discarded",
            timestamp: Date.now(),
          });
          // Notify the agent that changes were discarded
          runSession(
            wsServer,
            cmd.sessionKey!,
            "The user has discarded all worktree changes. Your work has been removed. The session is now operating on the main working tree.",
            discardSession.cwd,
            discardSession.sessionId ?? undefined,
            undefined,
            "leader",
          );
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
            broadcast(wsServer, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              approved: true,
              timestamp: Date.now(),
            });
            broadcast(wsServer, {
              type: "approval_resolved",
              sessionKey: cmd.sessionKey,
              action: "approved",
              timestamp: Date.now(),
            });
            // Notify the agent that approval succeeded (Task G: agent feedback)
            runSession(
              wsServer,
              cmd.sessionKey!,
              "Your changes have been approved and merged successfully into the main branch. The worktree has been cleaned up.",
              approveSession.cwd,
              approveSession.sessionId ?? undefined,
              undefined,
              "leader",
            );
          } else {
            // Merge failed — keep approval state so the UI stays visible
            broadcast(wsServer, {
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
      const forceSession = getSessionOrError(cmd.sessionKey, ws);
      if (!forceSession) return;
      if (!forceSession.worktree) {
        sendControlError(ws, "force_merge", cmd.sessionKey!, cmd.requestId, "No worktree for this session");
        return;
      }
      mergeAndCleanup(forceSession.worktree, undefined, { force: true })
        .then((result) => {
          if (result.success) {
            if (forceSession.taskState?.approval) {
              forceSession.taskState.approval = null;
            }
            forceSession.worktree = null;
            broadcast(wsServer, {
              type: "worktree_merged",
              sessionKey: cmd.sessionKey,
              result,
              cleaned: true,
              approved: true,
              timestamp: Date.now(),
            });
            broadcast(wsServer, {
              type: "approval_resolved",
              sessionKey: cmd.sessionKey,
              action: "approved",
              timestamp: Date.now(),
            });
            runSession(
              wsServer,
              cmd.sessionKey!,
              "Your changes have been force-merged successfully into the main branch (conflicts resolved by keeping your changes). The worktree has been cleaned up.",
              forceSession.cwd,
              forceSession.sessionId ?? undefined,
              undefined,
              "leader",
            );
          } else {
            broadcast(wsServer, {
              type: "worktree_merge_failed",
              sessionKey: cmd.sessionKey,
              result,
              timestamp: Date.now(),
            });
          }
          sendControlResponse(ws, "force_merge", cmd.sessionKey!, cmd.requestId, { result });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "force_merge", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
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
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Unknown command type: ${(cmd as WsCommand).type}`,
        }),
      );
    }
  }
}

// ── WebSocket handlers ───────────────────────────────────

wss.on("connection", (ws) => {
  console.log("Client connected");

  // Send current session list on connect
  const sessionList = Array.from(sessions.entries()).map(([key, s]) => ({
    sessionKey: key,
    sessionId: s.sessionId,
    status: s.status,
    cwd: s.cwd,
    totalCost: s.totalCost,
    turns: s.turns,
    model: s.model,
    permissionMode: s.permissionMode,
  }));
  ws.send(
    JSON.stringify({
      type: "session_list",
      sessions: sessionList,
    }),
  );

  ws.on("message", (raw) => {
    try {
      const cmd = JSON.parse(String(raw)) as WsCommand;
      handleCommand(wss, cmd, ws);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: "error", message: msg }));
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

  // Clean up stale worktrees from previous sessions
  void cleanupStaleWorktrees(process.cwd()).catch((err) => {
    console.warn("Worktree cleanup skipped:", err instanceof Error ? err.message : err);
  });
});

// ── Graceful shutdown: clean up all active worktrees ────────────────────────
async function shutdownCleanup(): Promise<void> {
  console.log("[shutdown] Cleaning up active worktrees...");
  const cleanups: Promise<void>[] = [];
  for (const [key, session] of sessions) {
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
