import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, MINION_CONTRACT } from "../graph.ts";
import type { TaskAssignment } from "../graph.ts";
import type { ServerMessage, SdkMessage, ContentBlock } from "../use-socket.ts";
import { MINION_SYSTEM_PROMPT } from "../prompts/minion-system.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { extractStreamDelta, isStreamingEvent } from "../streaming.ts";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";

registerContract(MINION_CONTRACT);

export interface MinionTaskState {
  taskId: string;
  title: string;
  description: string;
  priority: TaskAssignment["priority"];
  status: "pending" | "in_progress" | "completed" | "failed";
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

interface MinionMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "result";
  content: string;
  timestamp: number;
  toolName?: string;
  /** e.g. "8.6s · $0.0288" */
  suffix?: string;
}

function msgId(): string {
  return `mm-${crypto.randomUUID()}`;
}

// UI trigger patterns emitted by the minion agent
const STEP_RE = /\[STEP\]\s*(.+)/;
const DONE_RE = /\[DONE\]\s*(.+)/;
const FAIL_RE = /\[FAIL\]\s*(.+)/;

interface ParsedTrigger {
  type: "step" | "done" | "fail";
  message: string;
}

function parseTriggers(text: string): ParsedTrigger[] {
  const triggers: ParsedTrigger[] = [];
  for (const line of text.split("\n")) {
    const stepMatch = STEP_RE.exec(line);
    if (stepMatch) {
      triggers.push({ type: "step", message: stepMatch[1]!.trim() });
      continue;
    }
    const doneMatch = DONE_RE.exec(line);
    if (doneMatch) {
      triggers.push({ type: "done", message: doneMatch[1]!.trim() });
      continue;
    }
    const failMatch = FAIL_RE.exec(line);
    if (failMatch) {
      triggers.push({ type: "fail", message: failMatch[1]!.trim() });
      continue;
    }
  }
  return triggers;
}

function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      parts.push(`[Tool: ${block.name}]`);
    }
  }
  return parts.join("\n");
}

function sdkToMinionMessage(sdkMsg: SdkMessage): MinionMessage | null {
  const now = Date.now();
  switch (sdkMsg.type) {
    case "system": {
      const sub = sdkMsg.subtype;
      if (sub === "init") {
        const model = sdkMsg.model ?? "unknown";
        return { id: msgId(), role: "system", content: `Minion on ${model}`, timestamp: now };
      }
      if (sub === "task_started") {
        return { id: msgId(), role: "system", content: `Sub: ${sdkMsg.description ?? sdkMsg.task_id ?? "task"}`, timestamp: now };
      }
      if (sub === "task_notification") {
        const ico = sdkMsg.status === "completed" ? "\u2713" : "\u2717";
        return { id: msgId(), role: "system", content: `${ico} Sub ${sdkMsg.status}: ${sdkMsg.summary ?? ""}`, timestamp: now };
      }
      if (sub === "local_command_output" && sdkMsg.content) {
        return { id: msgId(), role: "system", content: sdkMsg.content, timestamp: now };
      }
      return null;
    }
    case "assistant":
      if (sdkMsg.message?.content) {
        const text = extractText(sdkMsg.message.content);
        if (!text.trim()) return null;
        return { id: msgId(), role: "assistant", content: text, timestamp: now };
      }
      return null;
    case "tool_progress":
      return {
        id: msgId(), role: "tool",
        content: `${sdkMsg.tool_name} (${sdkMsg.elapsed_time_seconds?.toFixed(1)}s)`,
        timestamp: now, toolName: sdkMsg.tool_name,
      };
    case "tool_use_summary":
      if (sdkMsg.summary) {
        return { id: msgId(), role: "system", content: sdkMsg.summary, timestamp: now };
      }
      return null;
    case "result": {
      const txt = sdkMsg.result ?? (sdkMsg.is_error ? "Error" : "Done");
      const ds = sdkMsg.duration_ms ? `${(sdkMsg.duration_ms / 1000).toFixed(1)}s` : null;
      const cs = sdkMsg.total_cost_usd ? `$${sdkMsg.total_cost_usd.toFixed(4)}` : null;
      const sfx = [ds, cs].filter(Boolean).join(" · ");
      return { id: msgId(), role: "result", content: txt, timestamp: now, suffix: sfx || undefined };
    }
    default:
      return null;
  }
}

function MinionNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  onResize,
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

  // Reset agent-subagent minions that were "running" on reload (can't re-attach)
  useEffect(() => {
    if (data.agentTaskId && !data.sessionKey && data.status === "running") {
      onUpdateData({
        ...data,
        status: "idle",
        streamingText: "",
        messages: [
          ...data.messages,
          {
            id: msgId(),
            role: "system" as const,
            content: "Subagent status unknown after reload — marked idle.",
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

          for (const evt of serverMsg.events) {
            if (evt.type === "sdk_event" && evt.message) {
              const mm = sdkToMinionMessage(evt.message as SdkMessage);
              if (mm) rebuiltMessages.push(mm);
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
          // Session no longer exists on server — reset to disconnected
          emitUpdate({
            ...current,
            status: "disconnected",
            sessionKey: null,
            streamingText: "",
            error: null,
          });
        }
        return;
      }

      if (!current.sessionKey) return;

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

        const mm = sdkToMinionMessage(serverMsg.message);
        if (mm) {
          const updated = { ...current };
          updated.messages = [...current.messages, mm];
          // Clear streaming buffer on complete assistant message
          if (serverMsg.message.type === "assistant") {
            updated.streamingText = "";

            // Parse UI triggers from assistant text
            if (mm.content && current.activeTaskIndex >= 0 && current.activeTaskIndex < current.taskQueue.length) {
              const triggers = parseTriggers(mm.content);
              if (triggers.length > 0) {
                const tasks = [...current.taskQueue];
                const task = tasks[current.activeTaskIndex];
                if (task) {
                  for (const trigger of triggers) {
                    if (trigger.type === "step") {
                      tasks[current.activeTaskIndex] = {
                        ...task,
                        activeStep: trigger.message,
                        progress: [...task.progress, trigger.message],
                      };
                    } else if (trigger.type === "done") {
                      tasks[current.activeTaskIndex] = {
                        ...task,
                        status: "completed",
                        result: trigger.message,
                        activeStep: null,
                      };
                    } else if (trigger.type === "fail") {
                      tasks[current.activeTaskIndex] = {
                        ...task,
                        status: "failed",
                        result: trigger.message,
                        activeStep: null,
                      };
                    }
                  }
                  updated.taskQueue = tasks;
                }
              }
            }
          }
          if (serverMsg.message.type === "result") {
            updated.totalCost =
              serverMsg.message.total_cost_usd ?? current.totalCost;
            updated.turns =
              serverMsg.message.num_turns ?? current.turns;
            updated.streamingText = "";
            // Ensure active task is marked completed if not already resolved by triggers
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
                  id: msgId(),
                  role: "user" as const,
                  content: `Starting task: ${nextTask.title}`,
                  timestamp: Date.now(),
                },
              ];
              // Send the next task to the existing session
              setTimeout(() => {
                socketSend({
                  type: "send_message",
                  sessionKey: current.sessionKey,
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
        emitUpdate({
          ...current,
          status: serverMsg.status as MinionData["status"],
        });
        return;
      }

      if (
        serverMsg.type === "session_error" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          status: "error" as const,
          error: serverMsg.error,
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

  const statusColor: Record<string, string> = {
    disconnected: "#4a5068",
    waiting: "#facc15",
    creating: "#facc15",
    running: "#4ade80",
    idle: "#60a5fa",
    stopped: "#f87171",
    error: "#ef4444",
  };

  const activeTask =
    data.activeTaskIndex >= 0 && data.activeTaskIndex < data.taskQueue.length
      ? data.taskQueue[data.activeTaskIndex]
      : undefined;

  const toolCount = data.messages.filter((m) => m.role === "tool").length;
  const completedCount = data.taskQueue.filter((t) => t.status === "completed").length;
  const totalTasks = data.taskQueue.length;
  const progressPct = totalTasks > 0 ? (completedCount / totalTasks) * 100 : 0;

  const priorityColors: Record<string, string> = {
    critical: "#ef4444",
    high: "#f97316",
    medium: "#60a5fa",
    low: "#4a5068",
  };

  const taskStatusIcon = (status: string) => {
    switch (status) {
      case "in_progress": return "⏳";
      case "completed": return "✓";
      case "failed": return "✗";
      default: return "○";
    }
  };

  const taskDotColor = (status: string) => {
    switch (status) {
      case "completed": return "#4ade80";
      case "in_progress": return "#facc15";
      case "failed": return "#ef4444";
      default: return "#4a5068";
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
        overflow: "hidden",
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
          background: "linear-gradient(135deg, #0a2a1a 0%, var(--bg-secondary) 100%)",
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
              background: statusColor[data.status] ?? "#4a5068",
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
              color: "#86efac",
              background: "rgba(134, 239, 172, 0.1)",
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
                background: "#3a1a1a",
                border: "1px solid #ef4444",
                borderRadius: 10,
                color: "#f87171",
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
          accent="#4ade80"
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
                ? "rgba(74, 222, 128, 0.05)"
                : activeTask.status === "failed"
                  ? "rgba(239, 68, 68, 0.05)"
                  : activeTask.status === "in_progress"
                    ? "rgba(250, 204, 21, 0.04)"
                    : "rgba(148, 163, 184, 0.03)",
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
              background: `${priorityColors[activeTask.priority] ?? "#4a5068"}22`,
              color: priorityColors[activeTask.priority] ?? "#4a5068",
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
              color: "#facc15",
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
              color: activeTask.status === "completed" ? "#4ade80" : "#f87171",
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
              background: "#4ade80",
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
                  {task.status === "pending" && data.status !== "running" && (
                    <button
                      onClick={() => startTask(i)}
                      onMouseDown={(e) => e.stopPropagation()}
                      style={{
                        padding: "0px 5px",
                        fontSize: 9,
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-default)",
                        borderRadius: 3,
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                        flexShrink: 0,
                        lineHeight: 1.5,
                      }}
                    >
                      Run
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
                  style={{
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
                        ? "2px solid #4ade80"
                        : "none",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 120,
                    overflow: "hidden",
                    opacity: msg.role === "system" ? 0.5 : 1,
                  }}
                >
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
              <StreamingBubble text={data.streamingText} borderColor="#4ade80" />
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
              borderLeft: "2px solid #4ade80",
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
            background: "#3a1a1a",
            color: "#f87171",
            fontSize: 11,
            borderTop: "1px solid #ef4444",
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
