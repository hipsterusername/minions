import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeRenderProps, ThinkingConfig } from "../types.ts";
import { MINION_THINKING_CONFIG } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, MINION_CONTRACT } from "../graph.ts";
import type { TaskAssignment } from "../graph.ts";
import type { ServerMessage } from "../use-socket.ts";
import { MINION_SYSTEM_PROMPT } from "../prompts/minion-system.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";
import { msgId, type DisplayMessage } from "../sdk-messages.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { AddAsNodeButton } from "../components/AddAsNodeButton.tsx";
import { STATUS_COLORS, PRIORITY_COLORS, getTaskStatusColor, COLORS } from "../palette.ts";
import {
  type SessionStreamState,
  type SessionStreamStatus,
} from "../session-stream.ts";
import { useSessionStream } from "../use-session-stream.ts";

registerContract(MINION_CONTRACT);

export interface MinionTaskState {
  taskId: string;
  title: string;
  description: string;
  priority: TaskAssignment["priority"];
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  activeStep: string | null;
  progress: string[];
  result: string | null;
}

export interface MinionData {
  sessionKey: string | null;
  status: "disconnected" | "waiting" | "creating" | "running" | "idle" | "stopped" | "error";
  leaderId: string | null;
  taskQueue: MinionTaskState[];
  activeTaskIndex: number;
  messages: MinionMessage[];
  totalCost: number;
  turns: number;
  error: string | null;
  streamingText: string;
  model: ModelOption;
  permissionMode: PermissionMode;
  /** Adaptive-thinking config sent to the SDK on every query() call. */
  thinkingConfig: ThinkingConfig;
  /** Set when this minion represents an SDK Agent-tool subagent (no independent session) */
  agentTaskId?: string | null;
  /** The leader's session key — used to receive subagent status updates */
  parentSessionKey?: string | null;
  /** Git worktree branch this minion is working on */
  worktreeBranch?: string | null;
}

// MinionMessage is now an alias for the shared DisplayMessage type
type MinionMessage = DisplayMessage;

/**
 * Project a {@link MinionData} onto the shared {@link SessionStreamState}
 * shape consumed by {@link useSessionStream}. The "waiting" status (an
 * initial-state marker that is never emitted by the server) is mapped to
 * "disconnected" so the reducer can run; the inverse mapping happens in
 * {@link applyCoreUpdate} below.
 */
function extractCore(d: MinionData): SessionStreamState {
  const status: SessionStreamStatus =
    d.status === "waiting" ? "disconnected" : d.status;
  return {
    sessionKey: d.sessionKey,
    status,
    messages: d.messages,
    streamingText: d.streamingText,
    totalCost: d.totalCost,
    turns: d.turns,
    error: d.error,
  };
}

export function MinionNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  onResize,
  onAddContentNode,
  projectPath,
}: NodeRenderProps) {
  const data = node.data as MinionData;
  const dataRef = useRef(data);
  dataRef.current = data;

  const [showLog, setShowLog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTaskList, setShowTaskList] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { banners, processSdkEvent, dismissBanner } = useStatusBanners();
  const syncedRef = useRef(false);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [data.messages.length]);

  // Request sync on mount if we have a sessionKey
  useEffect(() => {
    if (!socketSend || !data.sessionKey || syncedRef.current) return;
    syncedRef.current = true;
    socketSend({ type: "sync_session", sessionKey: data.sessionKey });
  }, [socketSend, data.sessionKey]);

  // Reset agent-subagent minions that were "running" on reload (can't re-attach).
  // Also catches idle-on-reload case where in_progress tasks were left behind.
  useEffect(() => {
    const hasStuckTasks = data.taskQueue.some((t) => t.status === "in_progress");
    if (data.agentTaskId && !data.sessionKey && (data.status === "running" || hasStuckTasks)) {
      const blockedTasks = data.taskQueue.map((t) =>
        t.status === "in_progress"
          ? { ...t, status: "blocked" as const, activeStep: null, result: "Subagent status unknown after reload." }
          : t,
      );
      onUpdateData({
        ...data,
        status: "idle",
        streamingText: "",
        activeTaskIndex: -1,
        taskQueue: blockedTasks,
        messages: [
          ...data.messages,
          {
            id: msgId(),
            role: "system" as const,
            content: "Subagent status unknown after reload — tasks marked blocked.",
            timestamp: Date.now(),
          },
        ],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper: update dataRef *synchronously* so rapid-fire WS events within the
  // same frame each see the latest state, then dispatch to React.
  const emitUpdate = useCallback(
    (next: MinionData) => {
      dataRef.current = next;
      onUpdateData(next);
    },
    [onUpdateData],
  );

  // ── Shared session-stream concerns via the controlled hook ────────
  //
  // The hook owns the WebSocket subscription for messages, status, cost,
  // turns, error and streaming-text deltas. Node-specific reactions to
  // these transitions (block in-progress tasks on stopped/error, add a
  // "Session lost" system message on sync !found) are layered into the
  // `onChange` below — we detect transitions on the inputs we already
  // have, no second subscription needed for them.
  //
  // Things the reducer *doesn't* see live in the secondary subscription
  // declared after this call: `minion_status` (MCP echoes), live `result`
  // SDK events (task completion + auto-advance + send_message), and
  // `agent_task_update` for SDK Agent-tool subagents.
  const applyCoreUpdate = useCallback(
    (next: SessionStreamState) => {
      const current = dataRef.current;

      // Map status: the reducer doesn't know about "waiting" (an
      // initial-state marker we use until a real session lands). If the
      // reducer reports "disconnected" but we were "waiting" and the key
      // didn't change, keep "waiting" so the UI doesn't flicker.
      const nextStatus: MinionData["status"] =
        current.status === "waiting" &&
        next.status === "disconnected" &&
        current.sessionKey === next.sessionKey
          ? "waiting"
          : next.status;

      let merged: MinionData = {
        ...current,
        sessionKey: next.sessionKey,
        status: nextStatus,
        messages: next.messages,
        streamingText: next.streamingText,
        totalCost: next.totalCost,
        turns: next.turns,
        error: next.error,
      };

      // ── sync_response !found transition ──
      // Reducer cleared sessionKey + set "disconnected"; we add a system
      // message and block any in-progress tasks so the user can retry.
      if (current.sessionKey !== null && next.sessionKey === null) {
        const blocked = current.taskQueue.map((t) =>
          t.status === "in_progress"
            ? {
                ...t,
                status: "blocked" as const,
                activeStep: null,
                result: "Session lost — requires user action to resume.",
              }
            : t,
        );
        merged = {
          ...merged,
          activeTaskIndex: -1,
          taskQueue: blocked,
          messages: [
            ...merged.messages,
            {
              id: msgId(),
              role: "system" as const,
              content:
                "Session lost after server restart. Blocked tasks require user action.",
              timestamp: Date.now(),
            },
          ],
        };
      }

      // ── session_status='stopped' transition ──
      if (current.status !== "stopped" && next.status === "stopped") {
        const blocked = current.taskQueue.map((t) =>
          t.status === "in_progress"
            ? {
                ...t,
                status: "blocked" as const,
                activeStep: null,
                result: "Session stopped — click Retry to resume.",
              }
            : t,
        );
        merged = { ...merged, activeTaskIndex: -1, taskQueue: blocked };
      }

      // ── session_error transition ──
      if (current.status !== "error" && next.status === "error") {
        const failed = current.taskQueue.map((t, i) =>
          i === current.activeTaskIndex && t.status === "in_progress"
            ? {
                ...t,
                status: "failed" as const,
                activeStep: null,
                result: next.error ?? "Session error",
              }
            : t,
        );
        merged = { ...merged, activeTaskIndex: -1, taskQueue: failed };
      }

      emitUpdate(merged);
    },
    [emitUpdate],
  );

  useSessionStream({
    ...(socketSubscribe ? { socketSubscribe } : {}),
    state: extractCore(data),
    onChange: applyCoreUpdate,
    prefix: "mm",
  });

  // ── Node-specific subscription (layered ON TOP of the hook) ───────
  //
  // Declared AFTER `useSessionStream` so it subscribes second and fires
  // second on each message — by the time this runs, `dataRef.current`
  // already reflects the hook's update from the same dispatch.
  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as ServerMessage;
      const current = dataRef.current;

      // ── minion_status MCP echoes: update the active task ──
      const m = serverMsg as Record<string, unknown>;
      if (
        m.type === "minion_status" &&
        m.minionSessionKey === current.sessionKey
      ) {
        const trigger = m.trigger as string;
        const message = m.message as string;
        if (
          current.activeTaskIndex >= 0 &&
          current.activeTaskIndex < current.taskQueue.length
        ) {
          const tasks = [...current.taskQueue];
          const task = tasks[current.activeTaskIndex];
          if (task) {
            if (trigger === "step") {
              tasks[current.activeTaskIndex] = {
                ...task,
                activeStep: message,
                progress: [...task.progress, message],
              };
            } else if (trigger === "done") {
              tasks[current.activeTaskIndex] = {
                ...task,
                status: "completed",
                result: message,
                activeStep: null,
              };
            } else if (trigger === "fail") {
              tasks[current.activeTaskIndex] = {
                ...task,
                status: "failed",
                result: message,
                activeStep: null,
              };
            }
            emitUpdate({ ...current, taskQueue: tasks });
          }
        }
        return;
      }

      // ── sdk_event: feed the banner processor + handle live results ──
      if (
        serverMsg.type === "sdk_event" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        processSdkEvent(serverMsg.message);

        // Live `result` event: hook already added cost/turns + the result
        // bubble. We layer task completion + auto-advance + send_message.
        if (serverMsg.message.type === "result") {
          let updated: MinionData = current;
          if (
            current.activeTaskIndex >= 0 &&
            current.activeTaskIndex < current.taskQueue.length
          ) {
            const tasks = [...current.taskQueue];
            const task = tasks[current.activeTaskIndex];
            if (task && task.status === "in_progress") {
              tasks[current.activeTaskIndex] = {
                ...task,
                status: "completed",
                result: serverMsg.message.result ?? "Done",
                activeStep: null,
              };
            }
            updated = { ...updated, taskQueue: tasks };
          }
          // Auto-advance: find next pending task and start it.
          const nextPending = updated.taskQueue.findIndex(
            (t) => t.status === "pending",
          );
          if (nextPending >= 0 && socketSend) {
            const nextTask = updated.taskQueue[nextPending]!;
            const advancedTasks = [...updated.taskQueue];
            advancedTasks[nextPending] = {
              ...nextTask,
              status: "in_progress",
            };
            updated = {
              ...updated,
              taskQueue: advancedTasks,
              activeTaskIndex: nextPending,
              status: "running",
              messages: [
                ...updated.messages,
                {
                  id: msgId("mm"),
                  role: "user" as const,
                  content: `Starting task: ${nextTask.title}`,
                  timestamp: Date.now(),
                },
              ],
            };
            // Capture sessionKey before the timeout to avoid stale closures.
            const sessionKeyForNext = current.sessionKey;
            setTimeout(() => {
              socketSend({
                type: "send_message",
                sessionKey: sessionKeyForNext,
                prompt: `## Next Task\n\n**Task ID:** ${nextTask.taskId}\n**Title:** ${nextTask.title}\n**Priority:** ${nextTask.priority}\n\n**Description:**\n${nextTask.description}\n\nPlease execute this task now.`,
              });
            }, 500);
          } else {
            updated = { ...updated, status: "idle" };
          }
          emitUpdate(updated);
        }
        return;
      }

      // ── agent_task_update: SDK Agent-tool subagent updates ──
      // When this minion represents an SDK subagent (no own session),
      // it receives status updates via this channel rather than its own
      // session_status events.
      if (
        serverMsg.type === "agent_task_update" &&
        current.agentTaskId &&
        m["taskId"] === current.agentTaskId
      ) {
        const status = m["status"] as string;
        const summary = m["summary"] as string;
        const tasks = [...current.taskQueue];
        const taskIdx =
          current.activeTaskIndex >= 0 ? current.activeTaskIndex : 0;
        const task = tasks[taskIdx];
        if (task) {
          const isComplete = status === "completed";
          const isFailed = status === "failed" || status === "error";
          tasks[taskIdx] = {
            ...task,
            status: isComplete ? "completed" : isFailed ? "failed" : task.status,
            result: summary || task.result,
            activeStep: isComplete || isFailed ? null : task.activeStep,
          };
          emitUpdate({
            ...current,
            taskQueue: tasks,
            status: isComplete ? "idle" : isFailed ? "error" : current.status,
            messages: [
              ...current.messages,
              {
                id: msgId(),
                role: "system" as const,
                content: `${isComplete ? "\u2713" : isFailed ? "\u2717" : "\u2026"} ${status}: ${summary}`,
                timestamp: Date.now(),
              },
            ],
          });
        }
      }
    });
  }, [socketSubscribe, emitUpdate, processSdkEvent, socketSend]);

  // Start working on a task
  const startTask = useCallback(
    (taskIndex: number) => {
      const current = dataRef.current;
      const task = current.taskQueue[taskIndex];
      if (!task || !socketSend) return;

      const key = current.sessionKey ?? `minion-${Date.now().toString(36)}`;
      const prompt = `## Task Assignment\n\n**Task ID:** ${task.taskId}\n**Title:** ${task.title}\n**Priority:** ${task.priority}\n\n**Description:**\n${task.description}\n\nPlease execute this task now.`;

      const tasks = [...current.taskQueue];
      tasks[taskIndex] = { ...task, status: "in_progress" };

      socketSend({
        type: current.sessionKey ? "send_message" : "create_session",
        sessionKey: key,
        prompt,
        systemPrompt: current.sessionKey ? undefined : MINION_SYSTEM_PROMPT,
        role: "minion",
        model: current.model,
        thinkingConfig: current.thinkingConfig ?? MINION_THINKING_CONFIG,
        // Minions don't create their own worktrees — they inherit the leader's.
        // Pass cwd so the session runs in the project dir (not the server's cwd).
        worktreeIsolation: false,
        ...(projectPath ? { cwd: projectPath } : {}),
      });

      onUpdateData({
        ...current,
        sessionKey: key,
        status: "running",
        activeTaskIndex: taskIndex,
        taskQueue: tasks,
        messages: [
          ...current.messages,
          {
            id: msgId(),
            role: "user" as const,
            content: `Starting task: ${task.title}`,
            timestamp: Date.now(),
          },
        ],
      });
    },
    [socketSend, onUpdateData],
  );

  const handleStop = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !current.sessionKey) return;
    socketSend({ type: "stop_session", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleInterrupt = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !current.sessionKey) return;
    socketSend({ type: "interrupt_session", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleModelChange = useCallback(
    (model: ModelOption) => {
      const current = dataRef.current;
      onUpdateData({ ...current, model });
      if (socketSend && current.sessionKey) {
        socketSend({ type: "set_model", sessionKey: current.sessionKey, model });
      }
    },
    [socketSend, onUpdateData],
  );

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      const current = dataRef.current;
      onUpdateData({ ...current, permissionMode: mode });
      if (socketSend && current.sessionKey) {
        socketSend({ type: "set_permission_mode", sessionKey: current.sessionKey, permissionMode: mode });
      }
    },
    [socketSend, onUpdateData],
  );

  const handleThinkingConfigChange = useCallback(
    (cfg: ThinkingConfig) => {
      const current = dataRef.current;
      onUpdateData({ ...current, thinkingConfig: cfg });
    },
    [onUpdateData],
  );

  const statusColor: Record<string, string> = STATUS_COLORS;

  const activeTask =
    data.activeTaskIndex >= 0 && data.activeTaskIndex < data.taskQueue.length
      ? data.taskQueue[data.activeTaskIndex]
      : undefined;

  const toolCount = data.messages.filter((m) => m.role === "tool").length;
  const completedCount = data.taskQueue.filter((t) => t.status === "completed").length;
  const totalTasks = data.taskQueue.length;
  const progressPct = totalTasks > 0 ? (completedCount / totalTasks) * 100 : 0;

  const priorityColors: Record<string, string> = PRIORITY_COLORS;

  const taskStatusIcon = (status: string) => {
    switch (status) {
      case "in_progress": return "\u23F3";
      case "completed": return "\u2713";
      case "failed": return "\u2717";
      case "blocked": return "\u26A0";
      default: return "\u25CB";
    }
  };

  const taskDotColor = (status: string) => {
    switch (status) {
      case "completed": return "var(--success-color)";
      case "in_progress": return "var(--status-creating)";
      case "failed": return "var(--danger-color)";
      case "blocked": return "var(--status-warning)";
      default: return "var(--text-muted)";
    }
  };

  // Inject pulse animation
  useEffect(() => {
    const id = "minion-pulse-keyframes";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `@keyframes minion-pulse{0%,100%{opacity:1}50%{opacity:0.4}}`;
    document.head.appendChild(style);
  }, []);

  // Auto-resize: observe content height and report to canvas
  useEffect(() => {
    if (!contentRef.current || !onResize) return;
    const el = contentRef.current;
    let lastHeight = 0;
    const observer = new ResizeObserver(() => {
      const h = Math.ceil(el.scrollHeight);
      const clamped = Math.max(60, Math.min(600, h));
      if (Math.abs(clamped - lastHeight) >= 2) {
        lastHeight = clamped;
        onResize({ width: node.size.width, height: clamped });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onResize, node.size.width]);

  return (
    <div
      ref={contentRef}
      style={{
        width: "100%",
        height: "fit-content",
        minHeight: 60,
        maxHeight: 600,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderRadius: 8,
        border: "1px solid var(--border-default)",
        overflow: "auto",
      }}
    >
      {/* ── Header (single compact row, ~32px) ── */}
      <div
        style={{
          padding: "6px 10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          background: "linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-secondary) 100%)",
          height: 32,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {/* Minion icon badge */}
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              background: `linear-gradient(135deg, ${statusColor[data.status] ?? "var(--text-muted)"}, ${statusColor[data.status] ?? "var(--text-muted)"}cc)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              flexShrink: 0,
              animation: data.status === "running" ? "minion-pulse 1.5s ease-in-out infinite" : "none",
            }}
          >
            <img
              src="/icons/minion.svg"
              alt="Minion"
              width={14}
              height={14}
              style={{ display: "block" }}
            />
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1 }}>
            Minion
          </span>
          {data.worktreeBranch && (
            <span style={{
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              color: "var(--success-color)",
              background: "var(--success-bg)",
              padding: "1px 5px",
              borderRadius: 3,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 100,
            }}>
              {data.worktreeBranch}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {data.totalCost > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              ${data.totalCost.toFixed(4)}
            </span>
          )}
          {data.status === "running" && (
            <button
              onClick={handleStop}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: "1px 7px",
                fontSize: 9,
                background: "var(--danger-bg)",
                border: "1px solid var(--danger-color)",
                borderRadius: 10,
                color: "var(--status-error)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                lineHeight: 1.4,
              }}
            >
              Stop
            </button>
          )}
          {/* Gear toggle for settings */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              color: showSettings ? "var(--text-secondary)" : "var(--text-muted)",
              padding: 0,
              lineHeight: 1,
              opacity: showSettings ? 1 : 0.6,
            }}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* ── Settings row (collapsible, hidden by default) ── */}
      {showSettings && (
        <SessionToolbar
          sessionKey={data.sessionKey}
          status={data.status}
          model={data.model ?? "sonnet"}
          permissionMode={data.permissionMode ?? "bypassPermissions"}
          onInterrupt={handleInterrupt}
          onModelChange={handleModelChange}
          onPermissionModeChange={handlePermissionModeChange}
          thinkingConfig={data.thinkingConfig ?? MINION_THINKING_CONFIG}
          onThinkingConfigChange={handleThinkingConfigChange}
          accent="var(--success-color)"
        />
      )}

      {/* ── Status banners ── */}
      <StatusBannerStack banners={banners} onDismiss={dismissBanner} />

      {/* ── Active Task (compact card) ── */}
      {activeTask && (
        <div
          style={{
            padding: "6px 10px",
            background:
              activeTask.status === "completed"
                ? "var(--success-bg)"
                : activeTask.status === "failed"
                  ? "var(--danger-bg)"
                  : activeTask.status === "blocked"
                    ? "var(--warning-bg)"
                    : activeTask.status === "in_progress"
                      ? "var(--warning-bg)"
                      : "var(--state-hover)",
            borderBottom: "1px solid var(--border-default)",
            flexShrink: 0,
          }}
        >
          {/* Title row: icon + title + priority pill */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
            <span style={{ fontSize: 11, flexShrink: 0 }}>
              {taskStatusIcon(activeTask.status)}
            </span>
            <span style={{
              fontSize: 12,
              color: "var(--text-primary)",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}>
              {activeTask.title}
            </span>
            <span style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 8,
              background: "var(--state-hover)",
              color: priorityColors[activeTask.priority] ?? "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              flexShrink: 0,
              lineHeight: 1.4,
            }}>
              {activeTask.priority}
            </span>
          </div>
          {/* Active step line */}
          {activeTask.activeStep && (
            <div style={{
              fontSize: 10,
              color: "var(--status-creating)",
              fontFamily: "var(--font-mono)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {activeTask.activeStep}
            </div>
          )}
          {/* Result line */}
          {activeTask.result && (
            <div style={{
              fontSize: 10,
              color: activeTask.status === "completed" ? "var(--success-color)" : activeTask.status === "blocked" ? "var(--status-warning)" : "var(--status-error)",
              fontFamily: "var(--font-mono)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {activeTask.result}
            </div>
          )}
        </div>
      )}

      {/* ── Task Progress (compact summary + expandable list) ── */}
      {totalTasks > 0 && (
        <div
          style={{
            borderBottom: "1px solid var(--border-default)",
            flexShrink: 0,
          }}
        >
          {/* Progress summary row */}
          <button
            onClick={() => setShowTaskList(!showTaskList)}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              padding: "5px 10px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              textAlign: "left",
            }}
          >
            <span style={{
              transition: "transform 0.2s",
              transform: showTaskList ? "rotate(90deg)" : "rotate(0deg)",
              fontSize: 7,
              color: "var(--text-muted)",
            }}>
              ▶
            </span>
            <span style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-secondary)",
            }}>
              Tasks {completedCount}/{totalTasks}
            </span>
          </button>
          {/* Thin progress bar */}
          <div style={{
            height: 3,
            background: "var(--bg-elevated)",
            margin: "0 10px 5px",
            borderRadius: 2,
            overflow: "hidden",
          }}>
            <div style={{
              width: `${progressPct}%`,
              height: "100%",
              background: "var(--success-color)",
              borderRadius: 2,
              transition: "width 0.3s ease",
            }} />
          </div>
          {/* Expanded task list */}
          {showTaskList && (
            <div style={{ padding: "0 10px 5px", display: "flex", flexDirection: "column", gap: 2 }}>
              {data.taskQueue.map((task, i) => (
                <div
                  key={task.taskId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                  }}
                >
                  <div style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: taskDotColor(task.status),
                    flexShrink: 0,
                  }} />
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: task.status === "completed" ? "var(--text-muted)" : "var(--text-secondary)",
                    textDecoration: task.status === "completed" ? "line-through" : "none",
                  }}>
                    {task.title}
                  </span>
                  {(task.status === "pending" || task.status === "blocked") && data.status !== "running" && (
                    <button
                      onClick={() => startTask(i)}
                      onMouseDown={(e) => e.stopPropagation()}
                      style={{
                        padding: "0px 5px",
                        fontSize: 9,
                        background: task.status === "blocked" ? "var(--warning-bg)" : "var(--bg-elevated)",
                        border: task.status === "blocked" ? "1px solid var(--status-warning)" : "1px solid var(--border-default)",
                        borderRadius: 3,
                        color: task.status === "blocked" ? "var(--status-warning)" : "var(--text-secondary)",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                        flexShrink: 0,
                        lineHeight: 1.5,
                      }}
                    >
                      {task.status === "blocked" ? "Retry" : "Run"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Execution log toggle + content ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <button
          onClick={() => setShowLog(!showLog)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "4px 10px",
            background: "transparent",
            border: "none",
            borderBottom: showLog ? "1px solid var(--border-default)" : "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textAlign: "left",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              transition: "transform 0.2s",
              transform: showLog ? "rotate(90deg)" : "rotate(0deg)",
              fontSize: 7,
            }}
          >
            ▶
          </span>
          Log ({data.messages.length})
        </button>

        {showLog && (
          <div
            ref={outputRef}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              maxHeight: 240,
              overflow: "auto",
              padding: "6px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {data.messages
              .filter((m) => m.role !== "tool")
              .map((msg) => (
                <div
                  key={msg.id}
                  className={msg.role === "assistant" ? "copyable" : undefined}
                  style={{
                    position: "relative",
                    padding: "4px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                    lineHeight: 1.6,
                    fontFamily: "var(--font-sans)",
                    color:
                      msg.role === "user"
                        ? "var(--accent)"
                        : "var(--text-primary)",
                    borderLeft:
                      msg.role === "assistant"
                        ? "2px solid var(--success-color)"
                        : "none",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 120,
                    overflow: "hidden",
                    opacity: msg.role === "system" ? 0.5 : 1,
                  }}
                >
                  {msg.role === "assistant" && <CopyButton text={msg.content} />}
                  {msg.role === "assistant" && <AddAsNodeButton text={msg.content} onAdd={onAddContentNode} />}
                  {msg.content}
                  {msg.suffix && (
                    <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.7 }}>
                      {msg.suffix}
                    </span>
                  )}
                </div>
              ))}
            {/* Streaming partial text in log */}
            {data.streamingText ? (
              <StreamingBubble text={data.streamingText} borderColor="var(--success-color)" />
            ) : data.status === "running" ? (
              <StreamingIndicator label="Working..." />
            ) : null}
          </div>
        )}

        {/* ── Streaming preview when log is closed ── */}
        {!showLog && data.streamingText && (
          <div
            style={{
              padding: "3px 10px",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-secondary)",
              borderLeft: "2px solid var(--success-color)",
              marginLeft: 10,
              marginRight: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {data.streamingText.split("\n").pop()}
            <span style={{ animation: "minion-pulse 1s ease-in-out infinite" }}>▍</span>
          </div>
        )}
      </div>

      {/* ── Waiting state ── */}
      {data.taskQueue.length === 0 && data.status !== "running" && (
        <div
          style={{
            padding: "12px",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 11,
            fontStyle: "italic",
          }}
        >
          Awaiting tasks…
        </div>
      )}

      {/* ── Error bar ── */}
      {data.error && (
        <div
          style={{
            padding: "5px 10px",
            background: "var(--danger-bg)",
            color: "var(--status-error)",
            fontSize: 11,
            borderTop: "1px solid var(--danger-color)",
            fontFamily: "var(--font-mono)",
            wordBreak: "break-word",
            flexShrink: 0,
          }}
        >
          {data.error}
        </div>
      )}
    </div>
  );
}

registerNodeType({
  type: "minion",
  label: "Minion",
  defaultSize: { width: 340, height: 140 },
  render: MinionNodeRenderer,
  userCreatable: false,
  autoHeight: true,
  agentType: "minion",
});

export const MINION_DEFAULT_DATA: MinionData = {
  sessionKey: null,
  status: "waiting",
  leaderId: null,
  taskQueue: [],
  activeTaskIndex: -1,
  messages: [],
  streamingText: "",
  totalCost: 0,
  turns: 0,
  error: null,
  model: "sonnet",
  permissionMode: "bypassPermissions",
  thinkingConfig: { ...MINION_THINKING_CONFIG },
  worktreeBranch: null,
};
