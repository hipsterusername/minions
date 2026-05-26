/**
 * Server-owned lifecycle projection for task records.
 *
 * The reducer is intentionally pure: callers hand it a TaskRecord plus one
 * lifecycle event and receive the next TaskRecord. Persistence and broadcast
 * happen only in applyLifecycleEvent().
 */

import type { Bus } from "./bus.ts";
import { emitTaskPlanUpdate } from "./task-tools/shared.ts";
import type { TaskManagerState, TaskRecord, TaskStatus } from "./task-tools/types.ts";
import { persistTaskState } from "./session-persist.ts";

export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export type TaskLifecycleEvent =
  | { type: "assigned"; minionSessionKey: string }
  | { type: "session_starting"; minionSessionKey?: string }
  | { type: "session_running" }
  | { type: "reported_step" }
  | { type: "reported_done"; result: string; timestamp?: number }
  | { type: "reported_fail"; result: string; timestamp?: number }
  | { type: "leader_completed"; result: string; timestamp?: number }
  | {
      type: "session_ended";
      reason: "clean" | "error" | "stop" | "close" | "remove" | "abort";
      result?: string | null;
      timestamp?: number;
    }
  | { type: "rehydrated_orphan"; timestamp?: number }
  | { type: "timeout"; result?: string; timestamp?: number }
  | { type: "parent_terminated"; timestamp?: number }
  | { type: "discarded"; timestamp?: number };

export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "ended_without_report",
  "cancelled",
  "orphaned",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

function taskTimeoutKey(leaderSessionKey: string, taskId: string): string {
  return `${leaderSessionKey}\0${taskId}`;
}

export function clearTaskTimeout(leaderSessionKey: string, taskId: string): void {
  const key = taskTimeoutKey(leaderSessionKey, taskId);
  const timer = taskTimeouts.get(key);
  if (!timer) return;
  clearTimeout(timer);
  taskTimeouts.delete(key);
}

export function scheduleTaskTimeout(opts: {
  bus: Bus;
  leaderSessionKey: string;
  taskState: TaskManagerState;
  taskId: string;
  timeoutMs?: number;
  onStateChange?: (state: TaskManagerState) => void;
  onTimeout?: () => void;
}): ReturnType<typeof setTimeout> {
  clearTaskTimeout(opts.leaderSessionKey, opts.taskId);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const timer = setTimeout(() => {
    taskTimeouts.delete(taskTimeoutKey(opts.leaderSessionKey, opts.taskId));
    const before = opts.taskState.tasks.get(opts.taskId);
    const next = applyLifecycleEvent({
      bus: opts.bus,
      leaderSessionKey: opts.leaderSessionKey,
      taskState: opts.taskState,
      taskId: opts.taskId,
      event: { type: "timeout", result: `Task timed out after ${Math.round(timeoutMs / 1000)}s.` },
      onStateChange: opts.onStateChange,
    });
    if (before && next !== before && next?.status === "failed") opts.onTimeout?.();
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  taskTimeouts.set(taskTimeoutKey(opts.leaderSessionKey, opts.taskId), timer);
  return timer;
}

export function reduceTaskLifecycle(
  task: TaskRecord,
  event: TaskLifecycleEvent,
  now = Date.now(),
): TaskRecord {
  if (isTerminalTaskStatus(task.status)) return task;

  switch (event.type) {
    case "assigned":
      return {
        ...task,
        executor: "minion",
        minionSessionKey: event.minionSessionKey,
        status: "starting",
      };

    case "session_starting":
      return {
        ...task,
        executor: "minion",
        minionSessionKey: event.minionSessionKey ?? task.minionSessionKey,
        status: "starting",
      };

    case "session_running":
    case "reported_step":
      if (task.status === "running") return task;
      return { ...task, status: "running" };

    case "reported_done":
      return closeTask(task, "completed", event.result, event.timestamp ?? now);

    case "leader_completed":
      return closeTask(
        { ...task, executor: "leader", minionSessionKey: null },
        "completed",
        event.result,
        event.timestamp ?? now,
      );

    case "reported_fail":
      return closeTask(task, "failed", event.result, event.timestamp ?? now);

    case "session_ended": {
      if (event.reason === "error") {
        return closeTask(
          task,
          "failed",
          event.result ?? "Session ended with an error.",
          event.timestamp ?? now,
        );
      }
      if (event.reason === "clean") {
        return closeTask(
          task,
          "ended_without_report",
          event.result ?? "Session ended without a minion report.",
          event.timestamp ?? now,
        );
      }
      return closeTask(
        task,
        "cancelled",
        `Session ${event.reason}.`,
        event.timestamp ?? now,
      );
    }

    case "rehydrated_orphan":
      return closeTask(
        task,
        "orphaned",
        "Task was running when the server restarted and no live minion session was found.",
        event.timestamp ?? now,
      );

    case "timeout":
      return closeTask(
        task,
        "failed",
        event.result ?? "Task timed out.",
        event.timestamp ?? now,
      );

    case "parent_terminated":
      return closeTask(
        task,
        "cancelled",
        "Parent session terminated.",
        event.timestamp ?? now,
      );

    case "discarded":
      return closeTask(
        task,
        "cancelled",
        "Worktree was discarded.",
        event.timestamp ?? now,
      );
  }
}

export function applyLifecycleEvent(opts: {
  bus: Bus;
  leaderSessionKey: string;
  taskState: TaskManagerState;
  taskId: string;
  event: TaskLifecycleEvent;
  onStateChange?: (state: TaskManagerState) => void;
}): TaskRecord | null {
  const current = opts.taskState.tasks.get(opts.taskId);
  if (!current) return null;

  const next = reduceTaskLifecycle(current, opts.event);
  if (next === current) {
    if (isTerminalTaskStatus(current.status)) {
      console.debug(
        `[task-lifecycle] ignored ${opts.event.type} for task ${opts.taskId} (${current.status})`,
      );
    }
    return current;
  }

  opts.taskState.tasks.set(opts.taskId, next);
  if (isTerminalTaskStatus(next.status)) clearTaskTimeout(opts.leaderSessionKey, opts.taskId);
  emitTaskPlanUpdate(
    opts.bus,
    opts.leaderSessionKey,
    opts.taskState,
    opts.onStateChange,
  );
  return next;
}

export function applySessionRunningForMinion(opts: {
  bus: Bus;
  minionSessionKey: string;
  forEachLeaderTaskState?: (fn: (leaderKey: string, taskState: TaskManagerState) => void) => void;
}): void {
  opts.forEachLeaderTaskState?.((leaderKey, taskState) => {
    for (const task of taskState.tasks.values()) {
      if (task.minionSessionKey !== opts.minionSessionKey) continue;
      applyLifecycleEvent({
        bus: opts.bus,
        leaderSessionKey: leaderKey,
        taskState,
        taskId: task.taskId,
        event: { type: "session_running" },
        onStateChange: (state) => persistTaskState(leaderKey, state),
      });
      return;
    }
  });
}

export function applySessionEndedForMinion(opts: {
  bus: Bus;
  minionSessionKey: string;
  reason: Extract<TaskLifecycleEvent, { type: "session_ended" }>["reason"];
  result?: string | null;
  forEachLeaderTaskState?: (fn: (leaderKey: string, taskState: TaskManagerState) => void) => void;
  onAfterLifecycle?: (leaderKey: string) => void;
}): void {
  opts.forEachLeaderTaskState?.((leaderKey, taskState) => {
    for (const task of taskState.tasks.values()) {
      if (task.minionSessionKey !== opts.minionSessionKey) continue;
      applyLifecycleEvent({
        bus: opts.bus,
        leaderSessionKey: leaderKey,
        taskState,
        taskId: task.taskId,
        event: { type: "session_ended", reason: opts.reason, result: opts.result },
        onStateChange: (state) => persistTaskState(leaderKey, state),
      });
      opts.onAfterLifecycle?.(leaderKey);
      return;
    }
  });
}

function closeTask(
  task: TaskRecord,
  status: Extract<
    TaskStatus,
    "completed" | "failed" | "ended_without_report" | "cancelled" | "orphaned"
  >,
  result: string,
  completedAt: number,
): TaskRecord {
  return {
    ...task,
    status,
    result,
    completedAt,
  };
}
