/** Durable attention delivery from child task state to its Leader. */

import type { SessionHost } from "./session-host.ts";
import type { SessionHostDeps } from "./session-host-types.ts";
import { persistTaskState } from "./session-persist.ts";
import { requestWaitResume } from "./wait-resume.ts";
import {
  buildWakeTaskDigest,
  isWakeWorthyStatus,
  requestCoalescedWake,
} from "./wake-coalescer.ts";
import { isTerminalTaskStatus } from "./task-lifecycle.ts";
import type { PendingWait, TaskManagerState, TaskRecord } from "./task-tools/types.ts";

export function ensureWaitCohort(
  state: TaskManagerState,
  wait: PendingWait,
): TaskRecord[] {
  if (!wait.taskIds) {
    wait.taskIds = Array.from(state.tasks.values())
      .filter((task) => task.executor === "minion" && (
        !isTerminalTaskStatus(task.status) ||
        (task.completedAt != null && task.completedAt >= wait.scheduledAt)
      ))
      .map((task) => task.taskId)
      .sort();
  }
  return wait.taskIds
    .map((taskId) => state.tasks.get(taskId))
    .filter((task): task is TaskRecord => task?.executor === "minion");
}

export function isWaitCohortSatisfied(
  tasks: TaskRecord[],
  wakeOn: PendingWait["wakeOn"] = "all_terminal",
): boolean {
  if (tasks.length === 0) return false;
  return wakeOn === "any_terminal"
    ? tasks.some((task) => isTerminalTaskStatus(task.status))
    : tasks.every((task) => isTerminalTaskStatus(task.status));
}

export function wakeLeaderFromDurableTaskState(
  host: SessionHost,
  deps: SessionHostDeps,
): void {
  const minionTasks = host.taskState
    ? Array.from(host.taskState.tasks.values()).filter((task) => task.executor === "minion")
    : [];
  const pendingWait = host.taskState?.pendingWait ?? null;
  const attentionTasks = minionTasks.filter(
    (task) => isWakeWorthyStatus(task.status) && task.attentionDeliveredAt == null,
  );

  if (pendingWait) {
    const wakeOn = pendingWait.wakeOn ?? "all_terminal";
    const waitTasks = ensureWaitCohort(host.taskState!, pendingWait);
    const conditionMet = isWaitCohortSatisfied(waitTasks, wakeOn);
    if (!conditionMet) return;
    const digest = buildWakeTaskDigest(waitTasks, pendingWait.scheduledAt);
    requestWaitResume(host, deps, {
      completedReason: "The delegated wait cohort reached its terminal policy.",
      immediate: wakeOn === "all_terminal",
      idempotencyKey: `wait:${host.id}:${pendingWait.scheduledAt}`,
      opts: {
        sessionKey: host.id,
        invocationKind: "resume_open_run",
        prompt:
          `Continue. The delegated wait cohort reached its terminal policy while waiting (${pendingWait.reason}). Pick up where you left off.` +
          (digest ? `\n\nTask results:\n${digest}` : ""),
        cwd: host.cwd,
        resumeId: host.sessionId ?? undefined,
        role: host.role,
        harness: host.harnessName,
      },
      onDelivered: () => markAttentionDelivered(host, waitTasks),
    });
    return;
  }

  // Queue while a Leader is still running; the coalescer delivers on idle.
  if (!host.taskState || host.abortController.signal.aborted) return;
  const meaningfulTasks = attentionTasks.filter((task) =>
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "ended_without_report" ||
    task.status === "blocked"
  );
  if (meaningfulTasks.length === 0) return;

  const digest = buildWakeTaskDigest(meaningfulTasks);
  requestCoalescedWake(host, deps, {
    opts: {
      sessionKey: host.id,
      invocationKind: "resume_open_run",
      prompt: `A delegated task reached a state needing your attention while you were idle:\n${digest}\nReview it (answer a blocked task with message_task) and continue orchestrating.`,
      cwd: host.cwd,
      resumeId: host.sessionId ?? undefined,
      role: host.role,
      harness: host.harnessName,
    },
    allowStopped: true,
    idempotencyKey: `tasks:${host.id}:${meaningfulTasks
      .map((task) => `${task.taskId}:${task.attentionRequestedAt ?? task.completedAt ?? task.createdAt}`)
      .sort()
      .join(",")}`,
    onDelivered: () => markAttentionDelivered(host, meaningfulTasks),
  });
}

function markAttentionDelivered(
  host: SessionHost,
  tasks: Array<{ attentionDeliveredAt?: number | null }>,
): void {
  const deliveredAt = Date.now();
  for (const task of tasks) {
    if (task.attentionDeliveredAt == null) task.attentionDeliveredAt = deliveredAt;
  }
  if (host.taskState) persistTaskState(host.id, host.taskState);
}
