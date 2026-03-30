/**
 * Task management MCP tools for the Leader agent.
 *
 * Uses `createSdkMcpServer` + `tool` from the Claude Agent SDK to expose
 * `assign_task`, `get_task_status`, and `list_tasks` as first-class tools
 * that the Leader can invoke instead of emitting JSON blocks in its text.
 *
 * Each tool handler has closure access to server-side state (sessions, WSS)
 * so it can create minion sessions and broadcast events to the frontend.
 */

import { z } from "zod/v4";
import {
  createSdkMcpServer,
  tool,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { WebSocketServer, WebSocket } from "ws";

// ── Shared state types ─────────────────────────────────

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  minionSessionKey: string | null;
  leaderSessionKey: string;
  status: "pending" | "assigned" | "running" | "completed" | "failed";
  assignedAt: number;
  result: string | null;
}

export interface TaskManagerState {
  tasks: Map<string, TaskRecord>;
}

// ── Broadcast helper ───────────────────────────────────

function broadcast(wss: WebSocketServer, data: unknown): void {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if ((client as WebSocket).readyState === 1 /* OPEN */) {
      (client as WebSocket).send(msg);
    }
  }
}

// ── Factory ────────────────────────────────────────────

/**
 * Create task management MCP tools bound to a specific leader session.
 *
 * Returns:
 *  - `mcpServer` config to pass into `query()` options.mcpServers
 *  - `taskState` so the server can inspect tasks externally
 */
export function createTaskToolsForLeader(opts: {
  leaderSessionKey: string;
  wss: WebSocketServer;
  /** Callback the handler calls to actually start a minion session */
  startMinionSession: (params: {
    sessionKey: string;
    prompt: string;
    cwd: string;
    systemPrompt: string;
  }) => void;
  cwd: string;
  minionSystemPrompt: string;
  /** Optional existing task state to preserve across resume calls */
  existingTaskState?: TaskManagerState;
  /** Worktree branch the leader session is running in */
  worktreeBranch?: string | null;
}) {
  const { leaderSessionKey, wss, startMinionSession, cwd, minionSystemPrompt } = opts;

  // Reuse existing task state on resume so get_task_status still works
  const taskState: TaskManagerState = opts.existingTaskState ?? { tasks: new Map() };

  // ── assign_task ────────────────────────────────────

  const assignTaskTool = tool(
    "assign_task",
    "Assign a task to a new Minion agent. Creates a minion session that will execute the task autonomously. Returns the minion session key for tracking.",
    {
      taskId: z.string().describe("Unique identifier for this task"),
      title: z.string().describe("Short title for the task"),
      description: z
        .string()
        .describe(
          "Detailed description with acceptance criteria. Include all necessary context — file paths, function names, expected behavior, constraints.",
        ),
      priority: z
        .enum(["low", "medium", "high", "critical"])
        .describe("Task priority level"),
    },
    async (args) => {
      const { taskId, title, description, priority } = args;

      // Prevent duplicate assignment
      if (taskState.tasks.has(taskId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} already assigned. Use get_task_status to check its progress.`,
            },
          ],
        };
      }

      const minionKey = `minion-${Date.now().toString(36)}-${taskId.slice(0, 8)}`;

      const record: TaskRecord = {
        taskId,
        title,
        description,
        priority,
        minionSessionKey: minionKey,
        leaderSessionKey,
        status: "assigned",
        assignedAt: Date.now(),
        result: null,
      };
      taskState.tasks.set(taskId, record);

      // Build the minion's initial prompt
      const prompt = [
        "## Task Assignment\n",
        `**Task ID:** ${taskId}`,
        `**Title:** ${title}`,
        `**Priority:** ${priority}\n`,
        `**Description:**\n${description}\n`,
        "Please execute this task now.",
      ].join("\n");

      // Start the minion session on the server
      startMinionSession({
        sessionKey: minionKey,
        prompt,
        cwd,
        systemPrompt: minionSystemPrompt,
      });

      record.status = "running";

      // Broadcast to frontend so it can create the minion node
      broadcast(wss, {
        type: "minion_spawned",
        leaderSessionKey,
        minionSessionKey: minionKey,
        taskId,
        title,
        description,
        priority,
        worktreeBranch: opts.worktreeBranch ?? null,
        timestamp: Date.now(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Task "${title}" (${taskId}) assigned to minion ${minionKey}. The minion session has started and is executing the task autonomously.`,
          },
        ],
      };
    },
  );

  // ── get_task_status ────────────────────────────────

  const getTaskStatusTool = tool(
    "get_task_status",
    "Check the status of one or all assigned tasks. Returns current status, minion session key, and any results.",
    {
      taskId: z
        .string()
        .optional()
        .describe(
          "Specific task ID to check. If omitted, returns status of all tasks.",
        ),
    },
    async (args) => {
      if (args.taskId) {
        const record = taskState.tasks.get(args.taskId);
        if (!record) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task ${args.taskId} not found.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(record, null, 2),
            },
          ],
        };
      }

      // Return all tasks
      const all = Array.from(taskState.tasks.values()).map((t) => ({
        taskId: t.taskId,
        title: t.title,
        priority: t.priority,
        status: t.status,
        minionSessionKey: t.minionSessionKey,
        result: t.result,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              all.length === 0
                ? "No tasks assigned yet."
                : JSON.stringify(all, null, 2),
          },
        ],
      };
    },
  );

  // ── set_task_name ──────────────────────────────────

  const setTaskNameTool = tool(
    "set_task_name",
    "Set a short display name for this leader session (3-6 words). Call once at the start.",
    {
      name: z.string().describe("Concise task name, 3-6 words"),
    },
    async (args) => {
      broadcast(wss, {
        type: "session_task_name",
        sessionKey: leaderSessionKey,
        taskName: args.name,
      });
      return {
        content: [
          { type: "text" as const, text: `Task name set: ${args.name}` },
        ],
      };
    },
  );

  // ── Build MCP server ───────────────────────────────

  const mcpServer = createSdkMcpServer({
    name: "task-manager",
    tools: [assignTaskTool, getTaskStatusTool, setTaskNameTool],
  });

  return { mcpServer, taskState };
}
