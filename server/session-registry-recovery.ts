/** Restart reconciliation for persisted Leader/minion workflow state. */

import type { SessionHost } from "./session-host.ts";
import type { SessionHostDeps } from "./session-host-types.ts";
import { applyLifecycleEvent, scheduleTaskTimeout } from "./task-lifecycle.ts";
import { persistTaskState } from "./session-persist.ts";
import { requestWaitResume } from "./wait-resume.ts";
import { ensureWaitCohort, isWaitCohortSatisfied } from "./leader-wake.ts";

export function recoverDurableWorkflowState(opts: {
  sessions: Iterable<[string, SessionHost]>;
  getSession: (key: string) => SessionHost | undefined;
  deps: SessionHostDeps;
  wakeLeader: (leaderKey: string) => void;
}): void {
  for (const [leaderKey, host] of opts.sessions) {
    if (!host.taskState || host.role !== "leader") continue;
    reconcileChildren(leaderKey, host, opts);
    persistTaskState(leaderKey, host.taskState);

    const wait = host.taskState.pendingWait;
    if (!wait) {
      opts.wakeLeader(leaderKey);
      continue;
    }
    const conditionMet = isWaitCohortSatisfied(
      ensureWaitCohort(host.taskState, wait),
      wait.wakeOn ?? "all_terminal",
    );
    if (conditionMet) {
      opts.wakeLeader(leaderKey);
      continue;
    }
    restoreWaitTimer(host, wait, opts.deps);
  }
}

function reconcileChildren(
  leaderKey: string,
  host: SessionHost,
  opts: {
    getSession: (key: string) => SessionHost | undefined;
    deps: SessionHostDeps;
  },
): void {
  for (const task of host.taskState!.tasks.values()) {
    if (task.status !== "running" && task.status !== "starting") continue;
    const child = task.minionSessionKey
      ? opts.getSession(task.minionSessionKey)
      : undefined;
    if (child && child.reviewLifecycle.terminalReason == null) {
      if (task.timeoutDeadlineAt != null) {
        scheduleTaskTimeout({
          bus: opts.deps.bus,
          leaderSessionKey: leaderKey,
          taskState: host.taskState!,
          taskId: task.taskId,
          timeoutMs: task.timeoutMs ?? undefined,
          deadlineAt: task.timeoutDeadlineAt,
          onStateChange: (state) => persistTaskState(leaderKey, state),
          onTimeout: () => task.minionSessionKey &&
            opts.deps.terminateSession?.(task.minionSessionKey, "abort"),
        });
      }
      continue;
    }
    const reason = child?.reviewLifecycle.terminalReason ?? null;
    const event = reason === "error"
      ? { type: "session_ended" as const, reason: "error" as const,
          result: child?.reviewLifecycle.finalReport }
      : reason === "completed"
        ? { type: "session_ended" as const, reason: "clean" as const,
            result: child?.reviewLifecycle.finalReport }
        : reason === "stop"
          ? { type: "session_ended" as const, reason: "stop" as const }
          : reason === "abort"
            ? { type: "session_ended" as const, reason: "abort" as const }
            : { type: "rehydrated_orphan" as const };
    applyLifecycleEvent({
      bus: opts.deps.bus,
      leaderSessionKey: leaderKey,
      taskState: host.taskState!,
      taskId: task.taskId,
      event,
    });
  }
}

function restoreWaitTimer(
  host: SessionHost,
  wait: NonNullable<NonNullable<SessionHost["taskState"]>["pendingWait"]>,
  deps: SessionHostDeps,
): void {
  host.clearWaitTimer();
  const resume = () => requestWaitResume(host, deps, {
    completedReason: wait.reason,
    immediate: true,
    idempotencyKey: `wait:${host.id}:${wait.scheduledAt}`,
    opts: {
      sessionKey: host.id,
      invocationKind: "resume_open_run",
      prompt: `Continue. The ${Math.round(wait.durationMs / 1000)}s wait has elapsed (reason: ${wait.reason}). Pick up where you left off.`,
      cwd: host.cwd,
      resumeId: host.sessionId ?? undefined,
      role: host.role,
      harness: host.harnessName,
    },
  });
  const remainingMs = wait.scheduledAt + wait.durationMs - Date.now();
  if (remainingMs <= 0) {
    resume();
    return;
  }
  host.waitTimerId = setTimeout(() => {
    host.waitTimerId = null;
    resume();
  }, remainingMs);
  host.waitTimerId.unref?.();
  wait.timerId = host.waitTimerId;
}
