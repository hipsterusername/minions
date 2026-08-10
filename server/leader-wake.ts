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
    const conditionMet = wakeOn === "any_terminal"
      ? minionTasks.some((task) => isWakeWorthyStatus(task.status))
      : !minionTasks.some((task) => !isWakeWorthyStatus(task.status));
    if (!conditionMet) return;
    const digest = buildWakeTaskDigest(minionTasks, pendingWait.scheduledAt);
    requestWaitResume(host, deps, {
      completedReason: "All delegated child tasks reached a wake-worthy state (terminal or blocked).",
      immediate: wakeOn === "all_terminal",
      idempotencyKey: `wait:${host.id}:${pendingWait.scheduledAt}`,
      opts: {
        sessionKey: host.id,
        invocationKind: "resume_open_run",
        prompt:
          `Continue. All delegated child tasks reached a wake-worthy state (terminal or blocked) while waiting (${pendingWait.reason}). Pick up where you left off.` +
          (digest ? `\n\nTask results:\n${digest}` : ""),
        cwd: host.cwd,
        resumeId: host.sessionId ?? undefined,
        role: host.role,
        harness: host.harnessName,
      },
      onDelivered: () => markAttentionDelivered(host, minionTasks),
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
