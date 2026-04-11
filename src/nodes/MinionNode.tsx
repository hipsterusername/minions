import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, MINION_CONTRACT } from "../graph.ts";
import type { TaskAssignment } from "../graph.ts";
import type { ServerMessage, SdkMessage } from "../use-socket.ts";
import { MINION_SYSTEM_PROMPT } from "../prompts/minion-system.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { extractStreamDelta, isStreamingEvent } from "../streaming.ts";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";
import { sdkToDisplayMessages, msgId, type DisplayMessage } from "../sdk-messages.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { AddAsNodeButton } from "../components/AddAsNodeButton.tsx";
import { STATUS_COLORS, PRIORITY_COLORS, getTaskStatusColor, COLORS } from "../palette.ts";

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
  /** Set when this minion represents an SDK Agent-tool subagent (no independent session) */
  agentTaskId?: string | null;
  /** The leader's session key — used to receive subagent status updates */
  parentSessionKey?: string | null;
  /** Git worktree branch this minion is working on */
  worktreeBranch?: string | null;
}

// MinionMessage is now an alias for the shared DisplayMessage type
type MinionMessage = DisplayMessage;

function sdkToMinionMessages(sdkMsg: SdkMessage): MinionMessage[] {
  return sdkToDisplayMessages(sdkMsg, "mm");
}

function MinionNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  onResize,
  onAddContentNode,
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

  // Subscribe to WebSocket events
  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as ServerMessage;
      const current = dataRef.current;

      // Handle sync_response (session rehydration on reload)
      if (
        serverMsg.type === "sync_response" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        if (serverMsg.found && serverMsg.events) {
          // Rebuild messages from buffered events
          const rebuiltMessages: MinionMessage[] = [];
          let rebuiltStatus = (serverMsg.status ?? current.status) as MinionData["status"];
          const rebuiltCost = serverMsg.totalCost ?? current.totalCost;
          const rebuiltTurns = serverMsg.turns ?? current.turns;

          const seenIds = new Set<string>();
          for (const evt of serverMsg.events) {
            if (evt.type === "sdk_event" && evt.message) {
              const mms = sdkToMinionMessages(evt.message as SdkMessage);
              for (const mm of mms) {
                if (!seenIds.has(mm.id)) {
                  seenIds.add(mm.id);
                  rebuiltMessages.push(mm);
                }
              }
            }
            if (evt.type === "session_status" && evt.status) {
              rebuiltStatus = evt.status as MinionData["status"];
            }
          }

          emitUpdate({
            ...current,
            status: rebuiltStatus,
            messages: rebuiltMessages.length > 0 ? rebuiltMessages : current.messages,
            totalCost: rebuiltCost,
            turns: rebuiltTurns,
            error: serverMsg.lastError ?? null,
            streamingText: "",
          });
        } else if (!serverMsg.found) {
          // Session no longer exists on server — mark in-progress tasks as blocked
          const blockedTasks = current.taskQueue.map((t) =>
            t.status === "in_progress"
              ? { ...t, status: "blocked" as const, activeStep: null, result: "Session lost — requires user action to resume." }
              : t,
          );
          emitUpdate({
            ...current,
            status: "disconnected",
            sessionKey: null,
            streamingText: "",
            error: null,
            activeTaskIndex: -1,
            taskQueue: blockedTasks,
            messages: [
              ...current.messages,
              {
                id: msgId(),
                role: "system" as const,
                content: "Session lost after server restart. Blocked tasks require user action.",
                timestamp: Date.now(),
              },
            ],
          });
        }
        return;
      }

      if (!current.sessionKey) return;

      // ── Handle structured minion_status events from MCP tools ──
      if (
        (serverMsg as Record<string, unknown>).type === "minion_status" &&
        (serverMsg as Record<string, unknown>).minionSessionKey === current.sessionKey
      ) {
        const trigger = (serverMsg as Record<string, unknown>).trigger as string;
        const message = (serverMsg as Record<string, unknown>).message as string;
        if (current.activeTaskIndex >= 0 && current.activeTaskIndex < current.taskQueue.length) {
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

      if (
        serverMsg.type === "sdk_event" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        processSdkEvent(serverMsg.message);

        // Handle streaming text deltas
        if (isStreamingEvent(serverMsg.message)) {
          const delta = extractStreamDelta(serverMsg.message);
          if (delta !== null) {
            emitUpdate({
              ...current,
              streamingText: (current.streamingText ?? "") + delta,
            });
          }
          return;
        }

        const mms = sdkToMinionMessages(serverMsg.message);
        if (mms.length > 0) {
          const existingIds = new Set(current.messages.map((m) => m.id));
          const newMsgs = mms.filter((m) => !existingIds.has(m.id));
          const updated = { ...current };
          if (newMsgs.length > 0) {
            let base = current.messages;
            // When a result arrives, drop the last assistant msg if its content
            // matches the result — the SDK sends both, but we only want the
            // green result bubble.
            if (serverMsg.message.type === "result") {
              const resultText = newMsgs.find((m) => m.role === "result")?.content;
              if (resultText) {
                const lastIdx = base.findLastIndex((m) => m.role === "assistant");
                if (lastIdx >= 0 && base[lastIdx].content.trim() === resultText.trim()) {
                  base = [...base.slice(0, lastIdx), ...base.slice(lastIdx + 1)];
                }
              }
            }
            updated.messages = [...base, ...newMsgs];
          }
          // Clear streaming buffer on complete assistant message
          if (serverMsg.message.type === "assistant") {
            updated.streamingText = "";
          }
          if (serverMsg.message.type === "result") {
            updated.totalCost =
              serverMsg.message.total_cost_usd ?? current.totalCost;
            updated.turns =
              serverMsg.message.num_turns ?? current.turns;
            updated.streamingText = "";
            // Ensure active task is marked completed if not already resolved by MCP tools
            if (current.activeTaskIndex >= 0 && current.activeTaskIndex < current.taskQueue.length) {
              const tasks = [...(updated.taskQueue ?? current.taskQueue)];
              const task = tasks[current.activeTaskIndex];
              if (task && task.status === "in_progress") {
                tasks[current.activeTaskIndex] = {
                  ...task,
                  status: "completed",
                  result: serverMsg.message.result ?? "Done",
                  activeStep: null,
                };
              }
              updated.taskQueue = tasks;
            }
            // Auto-advance: find next pending task and start it
            const nextTasks = updated.taskQueue ?? current.taskQueue;
            const nextPending = nextTasks.findIndex((t) => t.status === "pending");
            if (nextPending >= 0 && socketSend) {
              const nextTask = nextTasks[nextPending]!;
              const advancedTasks = [...nextTasks];
              advancedTasks[nextPending] = { ...nextTask, status: "in_progress" };
              updated.taskQueue = advancedTasks;
              updated.activeTaskIndex = nextPending;
              updated.status = "running";
              updated.messages = [
                ...updated.messages,
                {
                  id: msgId("mm"),
                  role: "user" as const,
                  content: `Starting task: ${nextTask.title}`,
                  timestamp: Date.now(),
                },
              ];
              // Send the next task to the existing session.
              // Capture sessionKey before the timeout to avoid stale-closure issues.
              const sessionKeyForNext = current.sessionKey;
              setTimeout(() => {
                socketSend({
                  type: "send_message",
                  sessionKey: sessionKeyForNext,
                  prompt: `## Next Task\n\n**Task ID:** ${nextTask.taskId}\n**Title:** ${nextTask.title}\n**Priority:** ${nextTask.priority}\n\n**Description:**\n${nextTask.description}\n\nPlease execute this task now.`,
                });
              }, 500);
            } else {
              updated.status = "idle";
            }
          }
          emitUpdate(updated);
        }
        return;
      }

      if (
        serverMsg.type === "session_status" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        const newStatus = serverMsg.status as MinionData["status"];
        // When a session is stopped, mark any in-progress tasks as blocked so
        // the user can see they need attention and retry them.
        const updatedTasks =
          newStatus === "stopped"
            ? current.taskQueue.map((t) =>
                t.status === "in_progress"
                  ? { ...t, status: "blocked" as const, activeStep: null, result: "Session stopped — click Retry to resume." }
                  : t,
              )
            : current.taskQueue;
        emitUpdate({
          ...current,
          status: newStatus,
          activeTaskIndex: newStatus === "stopped" ? -1 : current.activeTaskIndex,
          taskQueue: updatedTasks,
        });
        return;
      }

      if (
        serverMsg.type === "session_error" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        // Mark the active in-progress task as failed so it shows in the kanban
        // and can be retried, rather than staying stuck as "in_progress".
        const tasksAfterError = current.taskQueue.map((t, i) =>
          i === current.activeTaskIndex && t.status === "in_progress"
            ? { ...t, status: "failed" as const, activeStep: null, result: serverMsg.error ?? "Session error" }
            : t,
        );
        emitUpdate({
          ...current,
          status: "error" as const,
          error: serverMsg.error,
          activeTaskIndex: -1,
          taskQueue: tasksAfterError,
        });
        return;
      }

      // ── Handle Agent-tool subagent status updates ──
      // When this minion represents an SDK Agent-tool subagent,
      // it receives status updates via agent_task_update events
      // rather than its own session events.
      if (
        serverMsg.type === "agent_task_update" &&
        current.agentTaskId &&
        (serverMsg as Record<string, unknown>)["taskId"] === current.agentTaskId
      ) {
        const status = (serverMsg as Record<string, unknown>)["status"] as string;
        const summary = (serverMsg as Record<string, unknown>)["summary"] as string;
        const tasks = [...current.taskQueue];
        const taskIdx = current.activeTaskIndex >= 0 ? current.activeTaskIndex : 0;
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
  }, [socketSubscribe, emitUpdate, processSdkEvent]);

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
          {/* Status dot */}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor[data.status] ?? "var(--text-muted)",
              flexShrink: 0,
              animation: data.status === "running" ? "minion-pulse 1.5s ease-in-out infinite" : "none",
            }}
          />
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
  worktreeBranch: null,
};
