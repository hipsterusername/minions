/** Pure server-owned reducer plus persisted/broadcast lifecycle application. */
import type { Bus } from "./bus.ts";
import { emitTaskPlanUpdate } from "./task-tools/shared.ts";
import type { TaskManagerState, TaskRecord, TaskStatus } from "./task-tools/types.ts";
import { persistTaskState } from "./session-persist.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("task-lifecycle");

export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

interface TimeoutEntry {
  timer: ReturnType<typeof setTimeout>;
  reArm: () => ReturnType<typeof setTimeout>;
  attemptId: string | undefined;
  attemptGeneration: number | undefined;
}
const taskTimeouts = new Map<string, TimeoutEntry>();

type AttemptFence = {
  attemptId?: string;
  attemptGeneration?: number;
};

export type TaskLifecycleEvent = (
  | { type: "assigned"; minionSessionKey: string; nextAttemptId?: string; nextAttemptGeneration?: number }
  | { type: "session_starting"; minionSessionKey?: string }
  | { type: "session_running" }
  | { type: "reported_step"; message?: string }
  | { type: "report_nudged"; timestamp?: number }
  | { type: "reported_done"; result: string; timestamp?: number }
  | { type: "reported_fail"; result: string; timestamp?: number }
  | { type: "reported_blocked"; question: string; timestamp?: number }
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
  | { type: "discarded"; timestamp?: number }
  | { type: "cancelled"; result?: string; timestamp?: number }
) & AttemptFence;

export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(
  ["completed", "failed", "ended_without_report", "cancelled", "orphaned"],
);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export const RETRYABLE_TASK_STATUSES = new Set<TaskStatus>(
  ["failed", "ended_without_report", "orphaned", "cancelled"],
);

export function isRetryableTaskStatus(status: TaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.has(status);
}

function taskTimeoutKey(leaderSessionKey: string, taskId: string): string {
  return `${leaderSessionKey}\0${taskId}`;
}

export function clearTaskTimeout(leaderSessionKey: string, taskId: string): void {
  const key = taskTimeoutKey(leaderSessionKey, taskId);
  const entry = taskTimeouts.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  taskTimeouts.delete(key);
}

export function scheduleTaskTimeout(opts: {
  bus: Bus;
  leaderSessionKey: string;
  taskState: TaskManagerState;
  taskId: string;
  timeoutMs?: number;
  deadlineAt?: number;
  onStateChange?: (state: TaskManagerState) => void;
  onTimeout?: () => void;
}): ReturnType<typeof setTimeout> {
  const key = taskTimeoutKey(opts.leaderSessionKey, opts.taskId);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const scheduledAttempt = opts.taskState.tasks.get(opts.taskId);
  const attemptId = scheduledAttempt?.attemptId;
  const attemptGeneration = scheduledAttempt?.attemptGeneration;
  let restoreDeadline = opts.deadlineAt;

  function arm(): ReturnType<typeof setTimeout> {
    const prev = taskTimeouts.get(key);
    if (prev) clearTimeout(prev.timer);

    const deadlineAt = restoreDeadline ?? Date.now() + timeoutMs;
    restoreDeadline = undefined;
    const current = opts.taskState.tasks.get(opts.taskId);
    if (current && attemptMatches(current, { attemptId, attemptGeneration })) {
      opts.taskState.tasks.set(opts.taskId, {
        ...current,
        timeoutMs,
        timeoutDeadlineAt: deadlineAt,
      });
    }
    const timer = setTimeout(() => {
      taskTimeouts.delete(key);
      const before = opts.taskState.tasks.get(opts.taskId);
      const next = applyLifecycleEvent({
        bus: opts.bus,
        leaderSessionKey: opts.leaderSessionKey,
        taskState: opts.taskState,
        taskId: opts.taskId,
        event: { type: "timeout", result: `Task timed out after ${Math.round(timeoutMs / 1000)}s.`, attemptId, attemptGeneration },
        onStateChange: opts.onStateChange,
      });
      if (before && next !== before && next?.status === "failed") opts.onTimeout?.();
    }, Math.max(0, deadlineAt - Date.now()));
    (timer as { unref?: () => void }).unref?.();
    taskTimeouts.set(key, { timer, reArm: arm, attemptId, attemptGeneration });
    return timer;
  }

  const timer = arm();
  emitTaskPlanUpdate(opts.bus, opts.leaderSessionKey, opts.taskState, opts.onStateChange);
  return timer;
}

export function reduceTaskLifecycle(
  task: TaskRecord,
  event: TaskLifecycleEvent,
  now = Date.now(),
): TaskRecord {
  if (event.type !== "assigned" && !attemptMatches(task, event)) return task;
  if (isTerminalTaskStatus(task.status)) {
    if (event.type === "assigned" && isRetryableTaskStatus(task.status)) {
      return {
        ...task,
        executor: "minion",
        minionSessionKey: event.minionSessionKey,
        status: "starting",
        result: null,
        completedAt: null,
        attempt: (task.attempt ?? 1) + 1,
        attemptId: event.nextAttemptId ?? `${event.minionSessionKey}:${(task.attempt ?? 1) + 1}`,
        attemptGeneration: event.nextAttemptGeneration ?? (task.attemptGeneration ?? task.attempt ?? 1) + 1,
        timeoutDeadlineAt: null,
        previousAttempts: [
          ...(task.previousAttempts ?? []),
          {
            attempt: task.attempt ?? 1,
            attemptId: task.attemptId,
            attemptGeneration: task.attemptGeneration,
            minionSessionKey: task.minionSessionKey,
            status: task.status,
            result: task.result,
            completedAt: task.completedAt,
          },
        ],
        attentionRequestedAt: null,
        attentionDeliveredAt: null,
      };
    }
    return task;
  }

  switch (event.type) {
    case "assigned":
      return {
        ...task,
        executor: "minion",
        minionSessionKey: event.minionSessionKey,
        status: "starting",
        attempt: task.attempt ?? 1,
        attemptId: event.nextAttemptId ?? task.attemptId ?? `${event.minionSessionKey}:1`,
        attemptGeneration: event.nextAttemptGeneration ?? task.attemptGeneration ?? task.attempt ?? 1,
        timeoutDeadlineAt: null,
        attentionRequestedAt: null,
        attentionDeliveredAt: null,
      };

    case "session_starting":
      return {
        ...task,
        executor: "minion",
        minionSessionKey: event.minionSessionKey ?? task.minionSessionKey,
        status: "starting",
        attentionRequestedAt: null,
        attentionDeliveredAt: null,
      };

    case "session_running":
      if (task.status === "running") return task;
      return {
        ...task,
        status: "running",
        attentionRequestedAt: null,
        attentionDeliveredAt: null,
      };

    case "reported_step":
      return {
        ...task,
        status: "running",
        lastStep: event.message ?? task.lastStep,
        stepCount: (task.stepCount ?? 0) + 1,
        attentionRequestedAt: null,
        attentionDeliveredAt: null,
      };

    case "report_nudged":
      if (task.nudgedAt != null) return task;
      return { ...task, nudgedAt: event.timestamp ?? now };

    case "reported_done":
      return closeTask(task, "completed", event.result, event.timestamp ?? now);

    case "leader_completed":
      if (task.executor === "minion" && task.minionSessionKey) return task;
      return closeTask(
        { ...task, executor: "leader", minionSessionKey: null },
        "completed",
        event.result,
        event.timestamp ?? now,
      );

    case "reported_fail":
      return closeTask(task, "failed", event.result, event.timestamp ?? now);

    case "reported_blocked":
      return {
        ...task,
        status: "blocked",
        lastStep: event.question,
        attentionRequestedAt: event.timestamp ?? now,
        attentionDeliveredAt: null,
      };

    case "session_ended": {
      if (event.reason === "error") {
        return closeTask(task, "failed", event.result ?? "Session ended with an error.",
          event.timestamp ?? now);
      }
      if (event.reason === "clean") {
        return closeTask(task, "ended_without_report",
          event.result ?? "Session ended without a minion report.", event.timestamp ?? now);
      }
      return closeTask(task, "cancelled", `Session ${event.reason}.`, event.timestamp ?? now);
    }

    case "rehydrated_orphan":
      return closeTask(task, "orphaned",
        "Task had no live minion session after the server restarted; re-assign to resume.",
        event.timestamp ?? now);

    case "timeout":
      return closeTask(task, "failed", event.result ?? "Task timed out.", event.timestamp ?? now);

    case "parent_terminated":
      return closeTask(task, "cancelled", "Parent session terminated.", event.timestamp ?? now);

    case "discarded":
      return closeTask(task, "cancelled", "Worktree was discarded.", event.timestamp ?? now);

    case "cancelled":
      return closeTask(task, "cancelled", event.result ?? "Task cancelled by leader.",
        event.timestamp ?? now);
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
      log.debug("terminal_transition_ignored", {
        eventType: opts.event.type,
        taskId: opts.taskId,
        status: current.status,
      });
    }
    return current;
  }

  opts.taskState.tasks.set(opts.taskId, next);
  if (isTerminalTaskStatus(next.status)) {
    clearTaskTimeout(opts.leaderSessionKey, opts.taskId);
  } else if (next.status === "running" && opts.event.type === "reported_step") {
    const entry = taskTimeouts.get(taskTimeoutKey(opts.leaderSessionKey, opts.taskId));
    if (entry && attemptMatches(next, entry)) entry.reArm();
  }
  emitTaskPlanUpdate(opts.bus, opts.leaderSessionKey, opts.taskState, opts.onStateChange);
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
      const next = applyLifecycleEvent({
        bus: opts.bus,
        leaderSessionKey: leaderKey,
        taskState,
        taskId: task.taskId,
        event: { type: "session_ended", reason: opts.reason, result: opts.result },
      });
      // A wake must never outrun its recovery state. If persistence is
      // unavailable, leave the task unacknowledged in memory and do not
      // dispatch a continuation that cannot be reconstructed after a crash.
      if (next && persistTaskState(leaderKey, taskState)) {
        opts.onAfterLifecycle?.(leaderKey);
      }
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
  const requestsAttention = status !== "cancelled";
  return {
    ...task,
    status,
    result,
    completedAt,
    timeoutDeadlineAt: null,
    attentionRequestedAt: requestsAttention ? completedAt : null,
    attentionDeliveredAt: null,
  };
}

function attemptMatches(task: TaskRecord, fence: AttemptFence): boolean {
  if (fence.attemptId != null && task.attemptId !== fence.attemptId) return false;
  if (
    fence.attemptGeneration != null &&
    task.attemptGeneration !== fence.attemptGeneration
  ) return false;
  return true;
}
