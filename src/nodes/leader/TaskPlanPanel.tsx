import { useState } from "react";
import { createPortal } from "react-dom";
import { timeAgo } from "../leader-message-helpers.ts";
import type { TaskPlanItem } from "./types.ts";

/**
 * P4: Task Plan Panel.
 *
 * Shows the full task lifecycle: planned → running → completed/failed.
 * Driven entirely by `taskPlan[]` which is populated from deterministic
 * server-side `task_plan_update` broadcasts and minion completion events.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 5 of the leader refactor).
 */

const PRIORITY_COLORS: Record<string, string> = {
  critical: "var(--priority-critical)",
  high: "var(--priority-high)",
  medium: "var(--warning-color)",
  low: "var(--streaming-color)",
};

const TASK_STATUS_ICON: Record<TaskPlanItem["status"], string> = {
  planned: "○",
  starting: "◎",
  running: "◎",
  blocked: "⏸",
  completed: "✓",
  failed: "✗",
  ended_without_report: "!",
  cancelled: "○",
  orphaned: "!",
};

const TASK_STATUS_COLOR: Record<TaskPlanItem["status"], string> = {
  planned: "var(--text-muted)",
  starting: "var(--status-creating)",
  running: "var(--status-creating)",
  blocked: "var(--warning-color)",
  completed: "var(--success-color)",
  failed: "var(--danger-color)",
  ended_without_report: "var(--warning-color)",
  cancelled: "var(--text-muted)",
  orphaned: "var(--danger-color)",
};

function taskExecutorBadge(task: TaskPlanItem): {
  label: string;
  bg: string;
  color: string;
} {
  if (task.executor === "leader") {
    return {
      label: task.status === "completed" ? "self done" : "self",
      bg: "var(--state-active)",
      color: "var(--accent)",
    };
  }

  switch (task.status) {
    case "starting":
      return {
        label: "minion starting",
        bg: "var(--warning-bg)",
        color: "var(--status-creating)",
      };
    case "running":
      return {
        label: "minion in progress",
        bg: "var(--warning-bg)",
        color: "var(--status-creating)",
      };
    case "blocked":
      return {
        label: "needs input",
        bg: "var(--warning-bg)",
        color: "var(--warning-color)",
      };
    case "completed":
      return {
        label: "minion done",
        bg: "var(--success-bg)",
        color: "var(--success-color)",
      };
    case "failed":
      return {
        label: "minion failed",
        bg: "var(--danger-bg)",
        color: "var(--danger-color)",
      };
    case "ended_without_report":
      return {
        label: "no report",
        bg: "var(--warning-bg)",
        color: "var(--warning-color)",
      };
    case "cancelled":
      return {
        label: "cancelled",
        bg: "var(--state-hover)",
        color: "var(--text-muted)",
      };
    case "orphaned":
      return {
        label: "orphaned",
        bg: "var(--danger-bg)",
        color: "var(--danger-color)",
      };
    case "planned":
      return {
        label: "minion queued",
        bg: "var(--state-hover)",
        color: "var(--text-muted)",
      };
  }
}

export function TaskPlanPanel({
  taskPlan,
  expanded,
  onToggle,
  onRevealMinion,
}: {
  taskPlan: TaskPlanItem[];
  expanded: boolean;
  onToggle: () => void;
  onRevealMinion?: ((minionSessionKey: string) => void) | undefined;
}) {
  const [hoveredTask, setHoveredTask] = useState<number | null>(null);
  const [tooltipAnchor, setTooltipAnchor] = useState<DOMRect | null>(null);

  if (taskPlan.length === 0) return null;

  const completedCount = taskPlan.filter(
    (t) =>
      t.status === "completed" ||
      t.status === "failed" ||
      t.status === "ended_without_report" ||
      t.status === "cancelled" ||
      t.status === "orphaned",
  ).length;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "transparent",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border-default)" : "none",
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            fontSize: 8,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--text-muted)",
          }}
        >
          &#9654;
        </span>
        <span style={{ flex: 1 }}>
          Plan{" "}
          <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
            ({completedCount}/{taskPlan.length})
          </span>
        </span>
        {/* Live running indicator */}
        {taskPlan.some((t) => t.status === "running" || t.status === "starting") && (
          <span style={{ color: "var(--status-creating)", fontSize: 9, opacity: 0.8 }}>
            {taskPlan.filter((t) => t.status === "running" || t.status === "starting").length} running
          </span>
        )}
      </button>

      {/* Task list */}
      {expanded && (
        <div
          data-scroll-capture
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            maxHeight: 220,
            overflowY: "auto",
            padding: "4px 12px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {taskPlan.map((task, idx) => {
            const isMinion = task.executor === "minion";
            const canReveal =
              isMinion && onRevealMinion && (task.minionSessionKey || task.taskId);
            const executorBadge = taskExecutorBadge(task);
            return (
              <div
                key={task.taskId}
                onMouseEnter={(e) => {
                  setHoveredTask(idx);
                  setTooltipAnchor(
                    (e.currentTarget as HTMLElement).getBoundingClientRect(),
                  );
                }}
                onMouseLeave={() => {
                  setHoveredTask(null);
                  setTooltipAnchor(null);
                }}
                onClick={
                  canReveal
                    ? (e) => {
                        e.stopPropagation();
                        onRevealMinion!(task.minionSessionKey ?? task.taskId);
                      }
                    : undefined
                }
                onMouseDown={canReveal ? (e) => e.stopPropagation() : undefined}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  borderRadius: 4,
                  background: hoveredTask === idx ? "var(--bg-elevated)" : "transparent",
                  cursor: canReveal ? "pointer" : "default",
                  opacity: task.status === "planned" ? 0.6 : 1,
                }}
              >
                {/* Status icon */}
                <span
                  style={{
                    fontSize: 11,
                    color: TASK_STATUS_COLOR[task.status],
                    flexShrink: 0,
                    width: 14,
                    textAlign: "center",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {TASK_STATUS_ICON[task.status]}
                </span>

                {/* Title + live minion step */}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color:
                        task.status === "failed"
                          ? "var(--danger-color)"
                          : "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textDecoration:
                        task.status === "failed" ? "line-through" : "none",
                    }}
                  >
                    {task.title}
                  </span>
                  {task.activeStep &&
                    (task.status === "running" ||
                      task.status === "starting" ||
                      task.status === "blocked") && (
                    <span
                      style={{
                        fontSize: 9,
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.activeStep}
                    </span>
                  )}
                </span>

                {/* Executor/state badge — minion badges hint at click-to-reveal */}
                <span
                  style={{
                    fontSize: 9,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: executorBadge.bg,
                    color: executorBadge.color,
                    fontFamily: "var(--font-mono)",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                    ...(canReveal
                      ? { textDecoration: "underline", textUnderlineOffset: 2 }
                      : {}),
                  }}
                  title={canReveal ? "Click to view minion" : undefined}
                >
                  {canReveal && task.executor === "minion" ? "▸ " : ""}
                  {executorBadge.label}
                </span>

                {/* Priority */}
                <span
                  style={{
                    fontSize: 9,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: PRIORITY_COLORS[task.priority] ?? "var(--text-muted)",
                    color:
                      task.priority === "medium"
                        ? "var(--bg-primary)"
                        : "var(--text-primary)",
                    fontWeight: 600,
                    flexShrink: 0,
                    textTransform: "uppercase",
                    letterSpacing: 0.3,
                  }}
                >
                  {task.priority}
                </span>

                {/* Cost (minion tasks only, on completion) */}
                {task.cost > 0 && (
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      flexShrink: 0,
                    }}
                  >
                    ${task.cost.toFixed(4)}
                  </span>
                )}

                {/* Time */}
                {task.completedAt != null && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      flexShrink: 0,
                    }}
                  >
                    {timeAgo(task.completedAt)}
                  </span>
                )}

                {/* Hover tooltip — rendered via portal to escape overflow:hidden/auto containers */}
                {hoveredTask === idx &&
                  tooltipAnchor &&
                  (task.description ||
                    task.result ||
                    task.sessionSummary ||
                    task.activeStep ||
                    (task.progress?.length ?? 0) > 0) &&
                  createPortal(
                    <div
                      style={{
                        position: "fixed",
                        top: tooltipAnchor.top - 6,
                        left: tooltipAnchor.left,
                        transform: "translateY(-100%)",
                        zIndex: 99999,
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-default)",
                        borderRadius: 8,
                        padding: 12,
                        maxWidth: 360,
                        boxShadow: "var(--shadow-lg)",
                        pointerEvents: "none",
                      }}
                    >
                      {task.description && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-primary)",
                            marginBottom: 6,
                            lineHeight: 1.4,
                          }}
                        >
                          {task.description.length > 200
                            ? task.description.slice(0, 200) + "…"
                            : task.description}
                        </div>
                      )}
                      {task.minionSessionKey && (
                        <div
                          style={{
                            fontSize: 10,
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-muted)",
                            marginBottom: 4,
                            opacity: 0.7,
                          }}
                        >
                          {task.minionSessionKey}
                        </div>
                      )}
                      {(task.result ||
                        task.sessionSummary ||
                        (task.progress?.length ?? 0) > 0) && (
                        <div
                          style={{
                            fontSize: 10,
                            color: "var(--text-secondary, var(--text-muted))",
                            lineHeight: 1.4,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: 120,
                            overflowY: "auto",
                          }}
                        >
                          {task.result ??
                            (task.progress && task.progress.length > 0
                              ? task.progress.slice(-5).join("\n")
                              : task.sessionSummary)}
                        </div>
                      )}
                    </div>,
                    document.body,
                  )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
