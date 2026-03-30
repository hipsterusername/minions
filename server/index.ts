import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createProjectRoutes } from "./routes/projects.ts";
import { createTaskToolsForLeader, type TaskManagerState } from "./task-tools.ts";
import { createMinionToolsForSession } from "./minion-tools.ts";
import { MINION_SYSTEM_PROMPT } from "../src/prompts/minion-system.ts";
import { createWorktree, removeWorktree, mergeWorktree, getWorktreeStatus, isGitRepo, cleanupStaleWorktrees, type WorktreeInfo } from "./worktree.ts";

// ── Database ─────────────────────────────────────────────
console.log("Server starting (per-project SQLite mode)");

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// Mount REST API routes
app.use("/api/projects", createProjectRoutes());

// ── HTTP + WebSocket Server ──────────────────────────────
const PORT = parseInt(process.env["PORT"] ?? "3141", 10);
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ── Session management ──────────────────────────────────

const MAX_BUFFERED_EVENTS = 200;

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
    model: existing?.model ?? null,
    permissionMode: existing?.permissionMode ?? null,
    initData: existing?.initData ?? null,
    taskState: existing?.taskState ?? null,
    role: role ?? existing?.role ?? "default",
    taskName: existing?.taskName ?? (role === "leader" ? deriveTaskName(prompt) : null),
    worktree: parentWorktree ?? existing?.worktree ?? null,
    worktreeIsolation: worktreeIsolation !== false,
  };
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
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[worktree] Failed to create worktree for ${sessionKey}: ${errMsg}`);
        // Fall back to original cwd — don't prevent session from starting
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
    const fullTools = [
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

    const options: Record<string, unknown> = {
      cwd: session.cwd,
      resume: resumeId,
      allowedTools: fullTools,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController,
      includePartialMessages: true,
      promptSuggestions: true,
    };
    if (systemPrompt) {
      options["systemPrompt"] = systemPrompt;
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
      });
      options["mcpServers"] = { "task-manager": mcpServer };
      session.taskState = taskState;
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
          for (const [, otherSession] of sessions) {
            if (!otherSession.taskState) continue;
            for (const [, task] of otherSession.taskState.tasks) {
              if (task.minionSessionKey === sessionKey) {
                const isError = !!(msg["is_error"]);
                task.status = isError ? "failed" : "completed";
                task.result =
                  (msg["result"] as string) ??
                  (isError ? "Task failed" : "Task completed");
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
      const key = cmd.sessionKey ?? generateKey();
      const cwd = cmd.cwd ?? process.cwd();
      const prompt = cmd.prompt ?? "Hello";
      runSession(wsServer, key, prompt, cwd, undefined, cmd.systemPrompt, cmd.role, cmd.worktreeIsolation);
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
      runSession(
        wsServer,
        cmd.sessionKey,
        cmd.prompt,
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
          taskName: syncSession.taskName,
          role: syncSession.role,
          activeMinions: syncSession.taskState
            ? Array.from(syncSession.taskState.tasks.entries())
                .filter(([, t]) => t.status === "assigned" || t.status === "running")
                .map(([id, t]) => ({ taskId: id, title: t.title, status: t.status, sessionKey: t.minionSessionKey }))
            : [],
          events: syncSession.eventBuffer,
        }),
      );
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
              .filter(([, t]) => t.status === "assigned" || t.status === "running")
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

    case "close_session": {
      const closeSession = getSessionOrError(cmd.sessionKey, ws);
      if (!closeSession) return;
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
        // Stop if still running
        if (removeSession.queryHandle) {
          removeSession.queryHandle.close();
        }
        removeSession.abortController.abort();
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
              .filter(([, t]) => t.status === "assigned" || t.status === "running")
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
      mergeWorktree(mergeSession.worktree)
        .then((result) => {
          broadcast(wsServer, {
            type: "worktree_merged",
            sessionKey: cmd.sessionKey,
            result,
            timestamp: Date.now(),
          });
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
      removeWorktree(worktreePath)
        .then(() => {
          discardSession.worktree = null;
          broadcast(wsServer, {
            type: "worktree_removed",
            sessionKey: cmd.sessionKey,
            timestamp: Date.now(),
          });
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
      getWorktreeStatus(diffSession.worktree.path)
        .then((status) => {
          sendControlResponse(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, { status });
        })
        .catch((err: unknown) => {
          sendControlError(ws, "get_worktree_diff", cmd.sessionKey!, cmd.requestId, err instanceof Error ? err.message : String(err));
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

server.listen(PORT, () => {
  console.log(`Claude Canvas server on http://localhost:${PORT}`);
  console.log(`WebSocket available on ws://localhost:${PORT}`);

  // Clean up stale worktrees from previous sessions
  void cleanupStaleWorktrees(process.cwd()).catch((err) => {
    console.warn("Worktree cleanup skipped:", err instanceof Error ? err.message : err);
  });
});
