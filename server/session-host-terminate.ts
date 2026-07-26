import type { Bus } from "./bus.ts";
import type { SessionHost } from "./session-host.ts";
import type { TaskManagerState } from "./task-tools/types.ts";
import { applySessionEndedForMinion } from "./task-lifecycle.ts";
import { persistTaskState } from "./session-persist.ts";
import { getAgentTypeOrDefault } from "./agents/index.ts";
import { cancelQueuedWaitResume } from "./wait-resume.ts";
import { commitReviewLifecycle, finishRun } from "./session-review-lifecycle.ts";
import type { WorkItemRuntimeLifecycle } from "./session-host-types.ts";
import { notifyRuntimeTerminal } from "./session-host-identity.ts";
import {
  finalizeInvocationTermination,
  persistInvocationTerminationIntent,
} from "./work-item-run-start.ts";
import { awaitHarnessDrain } from "./harness/terminal-provenance.ts";
import { getRunInvocation, projectRunInvocationSeal } from "./work-item-invocations.ts";
import { persistenceDb } from "./session-persist.ts";

export type SessionTerminateReason = "stop" | "close" | "remove" | "abort";

export interface SessionTerminateDeps {
  bus: Bus;
  forEachLeaderTaskState?: (
    fn: (leaderKey: string, taskState: TaskManagerState) => void,
  ) => void;
  wakeWaitingLeaderIfAllChildrenTerminal?: (leaderKey: string) => void;
  /** Terminate another live session by key (used by leader child cleanup). */
  terminateSession?: (sessionKey: string, reason: SessionTerminateReason) => void;
  workItemLifecycle?: WorkItemRuntimeLifecycle;
  cleanupLiveEditRun?: (runKey: string) => void;
}

function hasOpenWaitEvidence(host: SessionHost, deps: SessionTerminateDeps | null): boolean {
  if (host.reviewLifecycle.reviewState === "decision_needed" || host.waitTimerId !== null
    || Boolean(host.taskState?.pendingWait)) return true;
  let blocked = false;
  deps?.forEachLeaderTaskState?.((_leaderKey, state) => {
    if ([...state.tasks.values()].some((task) =>
      task.minionSessionKey === host.id && task.status === "blocked")) blocked = true;
  });
  return blocked;
}

function projectTermination(host: SessionHost, reason: SessionTerminateReason) {
  const db = persistenceDb();
  const invocation = db && host.providerInvocationGeneration > 0
    ? getRunInvocation(db, host.runKey, host.providerInvocationGeneration)
    : null;
  return projectRunInvocationSeal({
    terminalKind: invocation?.terminal_kind ?? "cancelled",
    terminalSource: invocation?.terminal_source ?? "server",
    terminationIntent: invocation?.termination_intent ?? reason,
    cleanTerminalPolicy: "seal",
  });
}

export async function terminateSessionHost(
  host: SessionHost,
  deps: SessionTerminateDeps | null,
  reason: SessionTerminateReason,
): Promise<void> {
  // This commit is the crash boundary: no process signal may precede it.
  persistInvocationTerminationIntent(host, reason);
  // Capture openness before teardown changes the runtime status. Termination
  // may stop an already-idle host, but it must only seal a genuinely live run.
  const shouldSeal = !host.runtimeTerminalNotified
    && (host.status === "running" || (Boolean(host.workItemId)
      && !host.runtimeTerminalNotified && hasOpenWaitEvidence(host, deps)));
  const hadWaitTimer = host.waitTimerId !== null;
  host.clearWaitTimer();
  cancelQueuedWaitResume(host);
  if (host.taskState?.pendingWait) {
    host.taskState.pendingWait = null;
    persistTaskState(host.id, host.taskState);
  }
  if (hadWaitTimer && deps) {
    deps.bus.emitToSession(host.id, {
      type: "wait_state",
      sessionKey: host.id,
      action: "cancelled",
      reason: `Session ${reason}`,
      timestamp: Date.now(),
    });
  }

  // Capture the close promise BEFORE nulling runControl so we can await it
  // after the synchronous teardown is complete.
  const runControl = host.runControl;
  let closePromise: Promise<void> | undefined;
  if ((reason === "close" || reason === "remove") && runControl?.close) {
    closePromise = runControl.close();
  } else {
    runControl?.abort();
  }
  host.abortController.abort();
  // Abort paths deliberately leave claims to the harness stream finalizer.
  // Merely signalling abort is not proof that an in-flight mutation process
  // has stopped. Close paths release below only after close() acknowledges.
  host.status = "stopped";
  host.eventStream = null;
  host.runControl = null;
  host.persist();

  const event = {
    type: "session_status",
    sessionKey: host.id,
    status: "stopped",
    timestamp: Date.now(),
  };
  host.bufferEvent(event);
  deps?.bus.emitToSession(host.id, event);

  if (host.role === "minion" && deps) {
    applySessionEndedForMinion({
      bus: deps.bus,
      minionSessionKey: host.id,
      reason,
      forEachLeaderTaskState: deps.forEachLeaderTaskState,
      onAfterLifecycle: deps.wakeWaitingLeaderIfAllChildrenTerminal,
    });
  }

  // Role-specific session teardown (e.g. a leader aborting its still-running
  // minions on close/remove). This is the ONLY place agent types observe
  // session termination — run completion (`onComplete` on a `done` event)
  // must never be used for teardown of children.
  if (deps) {
    getAgentTypeOrDefault(host.role).onTerminate?.(
      {
        sessionKey: host.id,
        cwd: host.cwd,
        bus: deps.bus,
        worktreeInfo: host.worktree ?? null,
        worktreeIsolation: host.worktreeIsolation,
        ...(deps.terminateSession
          ? { terminateSession: deps.terminateSession }
          : {}),
        ...(deps.forEachLeaderTaskState
          ? { forEachLeaderTaskState: deps.forEachLeaderTaskState }
          : {}),
        ...(deps.wakeWaitingLeaderIfAllChildrenTerminal
          ? {
              wakeWaitingLeaderIfAllChildrenTerminal:
                deps.wakeWaitingLeaderIfAllChildrenTerminal,
            }
          : {}),
      },
      reason,
    );
  }

  // Let adapters consume a flushed terminal witness before the server makes
  // its cancelled claim. The wait is bounded by the harness evidence helper.
  await awaitHarnessDrain(runControl);
  const terminalAt = Date.now();
  finalizeInvocationTermination(host, terminalAt, () => {
    if (reason === "remove" || !deps || !shouldSeal) return;
    const projection = projectTermination(host, reason);
    if (projection.action !== "seal") return;
    commitReviewLifecycle(host, deps.bus, finishRun(host.reviewLifecycle, {
      reason: projection.outcome === "error" ? "error"
        : projection.outcome === "completed" ? "completed"
          : projection.outcome === "stopped" ? "stop" : "abort",
      at: terminalAt,
    }));
    notifyRuntimeTerminal(host, deps.workItemLifecycle, {
      outcome: projection.outcome,
      finalReportId: null, finalReport: null, at: terminalAt,
    });
  });
  host.persist();

  // Await orderly harness shutdown (close releases SDK resources such as
  // stdio handles or HTTP connections). All synchronous teardown above has
  // already completed at this point, so awaiting here is safe.
  if (closePromise !== undefined) {
    await closePromise;
    deps?.cleanupLiveEditRun?.(host.runKey);
  }
}
