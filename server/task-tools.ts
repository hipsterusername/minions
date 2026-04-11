/**
 * Task management MCP tools for the Leader agent.
 *
 * Uses `createSdkMcpServer` + `tool` from the Claude Agent SDK to expose
 * `plan_task`, `assign_task`, `complete_task`, `get_task_status`, and
 * `set_task_name` as first-class tools.
 *
 * Lifecycle:
 *   plan_task   → "planned"  (registered, not started)
 *   assign_task → "running"  (delegated to a new Minion session)
 *   complete_task → "completed" (leader executed it directly)
 *
 * The leader can also call assign_task on a pre-planned task to delegate it,
 * or complete_task to mark it done without spawning a minion.
 *
 * A `task_plan_update` broadcast fires on every state change so the frontend
 * always has an accurate, deterministic view of the full plan.
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
  /** Who is executing this task */
  executor: "leader" | "minion";
  minionSessionKey: string | null;
  leaderSessionKey: string;
  /** planned → running → completed | failed */
  status: "planned" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt: number | null;
  result: string | null;
}

export interface PendingWait {
  durationMs: number;
  reason: string;
  scheduledAt: number;
  /** Node.js timer handle — allows cancellation if the session is stopped */
  timerId: ReturnType<typeof setTimeout> | null;
}

export interface TaskManagerState {
  tasks: Map<string, TaskRecord>;
  /** If set, the leader has requested a wait-then-continue cycle */
  pendingWait: PendingWait | null;
}

// ── Broadcast helpers ──────────────────────────────────

function broadcast(wss: WebSocketServer, data: unknown): void {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if ((client as WebSocket).readyState === 1 /* OPEN */) {
      (client as WebSocket).send(msg);
    }
  }
}

function broadcastTaskPlanUpdate(
  wss: WebSocketServer,
  leaderSessionKey: string,
  taskState: TaskManagerState,
): void {
  broadcast(wss, {
    type: "task_plan_update",
    leaderSessionKey,
    tasks: Array.from(taskState.tasks.values()),
  });
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
  /** Callback to schedule a delayed "Continue" message to resume the leader */
  scheduleWaitContinue: (durationMs: number, reason: string) => void;
}) {
  const { leaderSessionKey, wss, startMinionSession, cwd, minionSystemPrompt } = opts;

  // Reuse existing task state on resume so get_task_status still works
  const taskState: TaskManagerState = opts.existingTaskState ?? { tasks: new Map(), pendingWait: null };

  // ── plan_task ──────────────────────────────────────
  // Register a task without starting it. The leader can later execute it
  // directly (complete_task) or delegate it to a minion (assign_task).

  const planTaskTool = tool(
    "plan_task",
    "Register a task in the plan without executing it yet. Use this to outline your work upfront. Each task can later be executed by you directly with complete_task, or delegated to a Minion with assign_task.",
    {
      taskId: z.string().describe("Unique identifier for this task"),
      title: z.string().describe("Short title for the task"),
      description: z
        .string()
        .describe("Detailed description of what needs to be done"),
      priority: z
        .enum(["low", "medium", "high", "critical"])
        .describe("Task priority level"),
    },
    async (args) => {
      const { taskId, title, description, priority } = args;

      if (taskState.tasks.has(taskId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} already exists in the plan.`,
            },
          ],
        };
      }

      const record: TaskRecord = {
        taskId,
        title,
        description,
        priority,
        executor: "leader", // default until delegated
        minionSessionKey: null,
        leaderSessionKey,
        status: "planned",
        createdAt: Date.now(),
        completedAt: null,
        result: null,
      };
      taskState.tasks.set(taskId, record);

      broadcastTaskPlanUpdate(wss, leaderSessionKey, taskState);

      return {
        content: [
          {
            type: "text" as const,
            text: `Task "${title}" (${taskId}) added to plan. Execute it yourself with complete_task, or delegate with assign_task.`,
          },
        ],
      };
    },
  );

  // ── assign_task ────────────────────────────────────
  // Delegate a task to a new Minion session. If the task was already
  // registered via plan_task, it transitions from "planned" → "running".
  // If not pre-planned, it is created and immediately delegated.

  const assignTaskTool = tool(
    "assign_task",
    "Delegate a task to a new Minion agent. Creates a minion session that will execute the task autonomously. If the task was registered with plan_task, it will transition from planned to running.",
    {
      taskId: z.string().describe("Unique identifier for this task (use the same ID as plan_task if pre-planned)"),
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

      // Check if already running/completed — don't re-assign
      const existing = taskState.tasks.get(taskId);
      if (existing && existing.status !== "planned") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} is already ${existing.status}. Use get_task_status to check its progress.`,
            },
          ],
        };
      }

      const minionKey = `minion-${Date.now().toString(36)}-${taskId.slice(0, 8)}`;

      if (existing) {
        // Transition pre-planned task to running
        existing.executor = "minion";
        existing.minionSessionKey = minionKey;
        existing.status = "running";
      } else {
        // Create and immediately delegate
        const record: TaskRecord = {
          taskId,
          title,
          description,
          priority,
          executor: "minion",
          minionSessionKey: minionKey,
          leaderSessionKey,
          status: "running",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        };
        taskState.tasks.set(taskId, record);
      }

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

      // Broadcast: minion_spawned so Canvas creates the node
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

      // Broadcast: full plan update so frontend reflects "running" status
      broadcastTaskPlanUpdate(wss, leaderSessionKey, taskState);

      return {
        content: [
          {
            type: "text" as const,
            text: `Task "${title}" (${taskId}) delegated to minion ${minionKey}. The minion session has started and is executing the task autonomously.`,
          },
        ],
      };
    },
  );

  // ── complete_task ──────────────────────────────────
  // Mark a task as completed by the leader itself (no minion involved).
  // If the task was pre-planned, transitions it to "completed".
  // If not pre-planned, auto-creates and immediately completes it.

  const completeTaskTool = tool(
    "complete_task",
    "Mark a task as completed by you (the leader) directly. Use this when you have executed a task yourself without delegating to a minion.",
    {
      taskId: z.string().describe("The task ID to mark as completed"),
      result: z
        .string()
        .describe("Summary of what was done and the outcome"),
    },
    async (args) => {
      const { taskId, result } = args;

      let record = taskState.tasks.get(taskId);

      if (!record) {
        // Auto-create if the leader completed something without pre-planning
        record = {
          taskId,
          title: taskId,
          description: "",
          priority: "medium",
          executor: "leader",
          minionSessionKey: null,
          leaderSessionKey,
          status: "planned",
          createdAt: Date.now(),
          completedAt: null,
          result: null,
        };
        taskState.tasks.set(taskId, record);
      }

      if (record.status === "completed" || record.status === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} is already ${record.status}.`,
            },
          ],
        };
      }

      record.executor = "leader";
      record.status = "completed";
      record.completedAt = Date.now();
      record.result = result;

      broadcastTaskPlanUpdate(wss, leaderSessionKey, taskState);

      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${taskId} marked as completed by leader.`,
          },
        ],
      };
    },
  );

  // ── get_task_status ────────────────────────────────

  const getTaskStatusTool = tool(
    "get_task_status",
    "Check the status of one or all tasks. Returns current status, executor, and any results.",
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
        executor: t.executor,
        minionSessionKey: t.minionSessionKey,
        result: t.result,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              all.length === 0
                ? "No tasks in plan yet."
                : JSON.stringify(all, null, 2),
          },
        ],
      };
    },
  );

  // ── wait_and_continue ──────────────────────────────
  // The leader calls this to pause execution for a specified duration,
  // then the system automatically resumes the session with "Continue".

  const waitAndContinueTool = tool(
    "wait_and_continue",
    "Pause execution for a specified duration, then the system will automatically resume your session with a \"Continue\" message. Use this when you need to wait for external processes (builds, deploys, tests) or to periodically check on long-running minion tasks. Maximum wait: 30 minutes.",
    {
      duration_seconds: z
        .number()
        .min(5)
        .max(1800)
        .describe("How long to wait in seconds (5–1800)"),
      reason: z
        .string()
        .describe("Why you are waiting (shown to the user in the UI)"),
    },
    async (args) => {
      const durationMs = args.duration_seconds * 1000;

      // Record the pending wait on the task state
      taskState.pendingWait = {
        durationMs,
        reason: args.reason,
        scheduledAt: Date.now(),
        timerId: null,
      };

      // Broadcast so the frontend can show the countdown immediately
      broadcast(wss, {
        type: "wait_state",
        sessionKey: leaderSessionKey,
        action: "started",
        durationMs,
        reason: args.reason,
        scheduledAt: Date.now(),
      });

      // Schedule the actual continuation via the server callback.
      // This fires after the SDK turn ends and the session goes idle.
      opts.scheduleWaitContinue(durationMs, args.reason);

      const mins = Math.floor(args.duration_seconds / 60);
      const secs = args.duration_seconds % 60;
      const display = mins > 0
        ? `${mins}m ${secs > 0 ? `${secs}s` : ""}`
        : `${secs}s`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Waiting ${display}. Reason: ${args.reason}. The session will automatically resume with "Continue" after the wait period.`,
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
    tools: [planTaskTool, assignTaskTool, completeTaskTool, getTaskStatusTool, setTaskNameTool, waitAndContinueTool],
  });

  return { mcpServer, taskState };
}
